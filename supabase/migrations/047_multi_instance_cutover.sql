-- 047_multi_instance_cutover.sql
-- Semantic cutover: apply only with deterministic resolver/callers deployed.

DO $$
DECLARE duplicate_scope TEXT;
BEGIN
  SELECT concat(account_id, ':', provider, ':', evolution_base_url, ':', evolution_instance)
  INTO duplicate_scope
  FROM whatsapp_config
  WHERE disabled_at IS NULL AND evolution_instance IS NOT NULL
  GROUP BY account_id, provider, evolution_base_url, evolution_instance
  HAVING count(*) > 1
  LIMIT 1;
  IF duplicate_scope IS NOT NULL THEN
    RAISE EXCEPTION 'ambiguous_config: duplicate active origin/instance %', duplicate_scope;
  END IF;

  IF EXISTS (
    SELECT 1 FROM whatsapp_config
    WHERE disabled_at IS NULL AND is_default
    GROUP BY account_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'ambiguous_config: account has multiple active defaults';
  END IF;
END $$;

ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;
DROP INDEX IF EXISTS whatsapp_config_one_active_per_account;
DROP INDEX IF EXISTS whatsapp_config_evolution_instance_key;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_one_default_per_account
  ON whatsapp_config(account_id)
  WHERE disabled_at IS NULL AND is_default;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_active_origin_instance_key
  ON whatsapp_config(account_id, provider, evolution_base_url, evolution_instance)
  WHERE disabled_at IS NULL AND evolution_instance IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_active_meta_origin_key
  ON whatsapp_config(account_id, provider, phone_number_id)
  WHERE disabled_at IS NULL AND evolution_instance IS NULL AND phone_number_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.can_access_department(
  p_account_id UUID,
  p_department_id UUID
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT is_account_member(p_account_id, 'admin') OR EXISTS (
    SELECT 1 FROM department_memberships dm
    WHERE dm.account_id = p_account_id
      AND dm.department_id = p_department_id
      AND dm.user_id = auth.uid()
  );
$$;
ALTER FUNCTION public.can_access_department(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_access_department(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_department(UUID, UUID) TO authenticated, service_role;

-- Departments: all account members see only memberships; owner/admin see all.
DROP POLICY IF EXISTS departments_select ON departments;
DROP POLICY IF EXISTS departments_insert ON departments;
DROP POLICY IF EXISTS departments_update ON departments;
DROP POLICY IF EXISTS departments_delete ON departments;
DROP POLICY IF EXISTS departments_select_department ON departments;
DROP POLICY IF EXISTS departments_insert_department ON departments;
DROP POLICY IF EXISTS departments_update_department ON departments;
DROP POLICY IF EXISTS departments_delete_department ON departments;
CREATE POLICY departments_select ON departments FOR SELECT USING (
  can_access_department(account_id, id)
);
CREATE POLICY departments_insert ON departments FOR INSERT WITH CHECK (
  is_account_member(account_id, 'admin')
);
CREATE POLICY departments_update ON departments FOR UPDATE USING (
  is_account_member(account_id, 'admin')
) WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY departments_delete ON departments FOR DELETE USING (
  is_account_member(account_id, 'admin') AND NOT is_default
);

DROP POLICY IF EXISTS department_memberships_select ON department_memberships;
DROP POLICY IF EXISTS department_memberships_insert ON department_memberships;
DROP POLICY IF EXISTS department_memberships_delete ON department_memberships;
CREATE POLICY department_memberships_select ON department_memberships FOR SELECT USING (
  is_account_member(account_id, 'admin') OR user_id = auth.uid()
);
CREATE POLICY department_memberships_insert ON department_memberships FOR INSERT WITH CHECK (
  is_account_member(account_id, 'admin')
  AND EXISTS (SELECT 1 FROM profiles p WHERE p.account_id = department_memberships.account_id AND p.user_id = department_memberships.user_id)
);
CREATE POLICY department_memberships_delete ON department_memberships FOR DELETE USING (
  is_account_member(account_id, 'admin')
  AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.id = department_memberships.department_id AND d.is_default)
);

-- Settings config: owners/admins retain global visibility; other roles see
-- configs only for departments they belong to.
DROP POLICY IF EXISTS whatsapp_config_select ON whatsapp_config;
DROP POLICY IF EXISTS whatsapp_config_insert ON whatsapp_config;
DROP POLICY IF EXISTS whatsapp_config_update ON whatsapp_config;
DROP POLICY IF EXISTS whatsapp_config_delete ON whatsapp_config;
DROP POLICY IF EXISTS whatsapp_config_select_department ON whatsapp_config;
DROP POLICY IF EXISTS whatsapp_config_insert_department ON whatsapp_config;
DROP POLICY IF EXISTS whatsapp_config_update_department ON whatsapp_config;
DROP POLICY IF EXISTS whatsapp_config_delete_department ON whatsapp_config;
CREATE POLICY whatsapp_config_select_department ON whatsapp_config FOR SELECT USING (
  can_access_department(account_id, department_id)
);
CREATE POLICY whatsapp_config_insert_department ON whatsapp_config FOR INSERT WITH CHECK (
  is_account_member(account_id, 'admin')
  AND EXISTS (SELECT 1 FROM departments d WHERE d.account_id = whatsapp_config.account_id AND d.id = whatsapp_config.department_id)
);
CREATE POLICY whatsapp_config_update_department ON whatsapp_config FOR UPDATE USING (
  is_account_member(account_id, 'admin')
) WITH CHECK (
  is_account_member(account_id, 'admin')
  AND EXISTS (SELECT 1 FROM departments d WHERE d.account_id = whatsapp_config.account_id AND d.id = whatsapp_config.department_id)
);
CREATE POLICY whatsapp_config_delete_department ON whatsapp_config FOR DELETE USING (
  is_account_member(account_id, 'admin')
);

DROP POLICY IF EXISTS conversations_select ON conversations;
DROP POLICY IF EXISTS conversations_insert ON conversations;
DROP POLICY IF EXISTS conversations_update ON conversations;
DROP POLICY IF EXISTS conversations_delete ON conversations;
DROP POLICY IF EXISTS conversations_select_department ON conversations;
DROP POLICY IF EXISTS conversations_insert_department ON conversations;
DROP POLICY IF EXISTS conversations_update_department ON conversations;
DROP POLICY IF EXISTS conversations_delete_department ON conversations;
CREATE POLICY conversations_select_department ON conversations FOR SELECT USING (
  can_access_department(account_id, department_id)
);
CREATE POLICY conversations_insert_department ON conversations FOR INSERT WITH CHECK (
  is_account_member(account_id, 'agent') AND can_access_department(account_id, department_id)
);
CREATE POLICY conversations_update_department ON conversations FOR UPDATE USING (
  is_account_member(account_id, 'agent') AND can_access_department(account_id, department_id)
) WITH CHECK (
  is_account_member(account_id, 'agent') AND can_access_department(account_id, department_id)
);
CREATE POLICY conversations_delete_department ON conversations FOR DELETE USING (
  is_account_member(account_id, 'agent') AND can_access_department(account_id, department_id)
);

DROP POLICY IF EXISTS flow_runs_select ON flow_runs;
DROP POLICY IF EXISTS flow_runs_select_department ON flow_runs;
CREATE POLICY flow_runs_select_department ON flow_runs FOR SELECT USING (
  can_access_department(account_id, department_id)
);
DROP POLICY IF EXISTS automation_logs_select ON automation_logs;
DROP POLICY IF EXISTS automation_logs_select_department ON automation_logs;
CREATE POLICY automation_logs_select_department ON automation_logs FOR SELECT USING (
  can_access_department(account_id, department_id)
);

-- Recipients follow broadcast access plus their immutable department snapshot.
DROP POLICY IF EXISTS broadcast_recipients_select ON broadcast_recipients;
DROP POLICY IF EXISTS broadcast_recipients_modify ON broadcast_recipients;
DROP POLICY IF EXISTS broadcast_recipients_select_department ON broadcast_recipients;
DROP POLICY IF EXISTS broadcast_recipients_modify_department ON broadcast_recipients;
CREATE POLICY broadcast_recipients_select_department ON broadcast_recipients FOR SELECT USING (
  can_access_department(account_id, department_id)
);
CREATE POLICY broadcast_recipients_modify_department ON broadcast_recipients FOR ALL USING (
  is_account_member(account_id, 'agent') AND can_access_department(account_id, department_id)
) WITH CHECK (
  is_account_member(account_id, 'agent') AND can_access_department(account_id, department_id)
);

COMMENT ON INDEX whatsapp_config_one_default_per_account IS
  'Deterministic account fallback; accounts with one active config remain backward compatible.';
