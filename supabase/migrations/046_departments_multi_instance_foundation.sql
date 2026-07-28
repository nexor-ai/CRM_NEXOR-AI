-- 046_departments_multi_instance_foundation.sql
-- Additive/idempotent foundation. No legacy uniqueness is removed here.

CREATE TABLE IF NOT EXISTS departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT departments_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT departments_account_id_id_key UNIQUE (account_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS departments_name_per_account_key
  ON departments (account_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS departments_one_default_per_account
  ON departments (account_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS departments_account_idx ON departments(account_id, created_at, id);
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS department_memberships (
  department_id UUID NOT NULL,
  account_id UUID NOT NULL,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (department_id, user_id),
  CONSTRAINT department_memberships_department_account_fk
    FOREIGN KEY (account_id, department_id)
    REFERENCES departments(account_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS department_memberships_user_idx
  ON department_memberships(account_id, user_id, department_id);
ALTER TABLE department_memberships ENABLE ROW LEVEL SECURITY;

-- Supabase normally grants public-schema tables through default privileges,
-- but explicit least-privilege grants keep this migration portable and make
-- the RLS policies below effective in fresh/local projects too.
REVOKE ALL ON TABLE departments, department_memberships FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE departments, department_memberships TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE departments, department_memberships TO service_role;

-- Deterministic UUIDv5 means a partially applied/re-run migration converges to
-- the same default row. ORDER BY makes lock/acquisition order deterministic.
INSERT INTO departments (id, account_id, name, is_default, created_by_user_id)
SELECT uuid_generate_v5(a.id, 'nexor-default-department'), a.id,
       'Geral', TRUE, a.owner_user_id
FROM accounts a
ORDER BY a.id
ON CONFLICT DO NOTHING;

-- Heal accounts that predate a manually-created non-default department.
INSERT INTO departments (id, account_id, name, is_default, created_by_user_id)
SELECT uuid_generate_v5(a.id, 'nexor-default-department'), a.id,
       'Geral', TRUE, a.owner_user_id
FROM accounts a
WHERE NOT EXISTS (SELECT 1 FROM departments d WHERE d.account_id = a.id AND d.is_default)
ORDER BY a.id
ON CONFLICT DO NOTHING;

INSERT INTO department_memberships (department_id, account_id, user_id)
SELECT d.id, p.account_id, p.user_id
FROM profiles p
JOIN departments d ON d.account_id = p.account_id AND d.is_default
ORDER BY p.account_id, p.user_id
ON CONFLICT (department_id, user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.ensure_default_department_membership(
  p_account_id UUID,
  p_user_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_department_id UUID;
BEGIN
  IF p_account_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'account_id and user_id are required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO departments (id, account_id, name, is_default, created_by_user_id)
  SELECT uuid_generate_v5(a.id, 'nexor-default-department'), a.id,
         'Geral', TRUE, a.owner_user_id
  FROM accounts a WHERE a.id = p_account_id
  ON CONFLICT DO NOTHING;

  SELECT id INTO v_department_id
  FROM departments
  WHERE account_id = p_account_id AND is_default
  ORDER BY id
  LIMIT 1;
  IF v_department_id IS NULL THEN
    RAISE EXCEPTION 'Default department not found' USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.user_id = p_user_id AND p.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'User is not a member of account' USING ERRCODE = '42501';
  END IF;

  INSERT INTO department_memberships (department_id, account_id, user_id)
  VALUES (v_department_id, p_account_id, p_user_id)
  ON CONFLICT (department_id, user_id) DO NOTHING;
  RETURN v_department_id;
END;
$$;
ALTER FUNCTION public.ensure_default_department_membership(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ensure_default_department_membership(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_default_department_membership(UUID, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.sync_profile_default_department_membership()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.account_id IS DISTINCT FROM NEW.account_id THEN
    DELETE FROM department_memberships WHERE user_id = NEW.user_id AND account_id = OLD.account_id;
  END IF;
  PERFORM ensure_default_department_membership(NEW.account_id, NEW.user_id);
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sync_profile_default_department_membership() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_profile_default_department_membership() FROM PUBLIC;
DROP TRIGGER IF EXISTS sync_profile_default_department_membership ON profiles;
CREATE TRIGGER sync_profile_default_department_membership
  AFTER INSERT OR UPDATE OF account_id ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_default_department_membership();

CREATE OR REPLACE FUNCTION public.sync_department_creator_membership()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.created_by_user_id IS NOT NULL THEN
    INSERT INTO department_memberships (
      department_id, account_id, user_id, created_by_user_id
    )
    SELECT NEW.id, NEW.account_id, NEW.created_by_user_id, NEW.created_by_user_id
    FROM profiles p
    WHERE p.user_id = NEW.created_by_user_id
      AND p.account_id = NEW.account_id
    ON CONFLICT (department_id, user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sync_department_creator_membership() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_department_creator_membership() FROM PUBLIC;
DROP TRIGGER IF EXISTS sync_department_creator_membership ON departments;
CREATE TRIGGER sync_department_creator_membership
  AFTER INSERT ON departments
  FOR EACH ROW EXECUTE FUNCTION public.sync_department_creator_membership();

-- handle_new_user, redeem_invitation and remove_account_member all insert/update
-- profiles; the trigger above therefore keeps signup/invite/redeem/removal safe,
-- atomic and idempotent without duplicating those SECURITY DEFINER RPC bodies.

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS department_id UUID,
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'evolution',
  ADD COLUMN IF NOT EXISTS webhook_identity UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS webhook_secret_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_webhook_identity_key
  ON whatsapp_config(webhook_identity);

UPDATE whatsapp_config wc
SET department_id = d.id
FROM departments d
WHERE d.account_id = wc.account_id AND d.is_default
  AND wc.department_id IS NULL;

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY account_id
    ORDER BY (disabled_at IS NULL) DESC, created_at, id
  ) AS rn
  FROM whatsapp_config
)
UPDATE whatsapp_config wc SET is_default = TRUE
FROM ranked r WHERE r.id = wc.id AND r.rn = 1
  AND NOT EXISTS (
    SELECT 1 FROM whatsapp_config existing
    WHERE existing.account_id = wc.account_id AND existing.is_default
  );

ALTER TABLE whatsapp_config ALTER COLUMN department_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS whatsapp_config_department_idx
  ON whatsapp_config(account_id, department_id) WHERE disabled_at IS NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS department_id UUID;
UPDATE conversations c
SET department_id = COALESCE(
  (
    SELECT wc.department_id
    FROM whatsapp_config wc
    WHERE wc.id = c.whatsapp_config_id
      AND wc.account_id = c.account_id
  ),
  d.id
)
FROM departments d
WHERE d.account_id = c.account_id AND d.is_default AND c.department_id IS NULL;
ALTER TABLE conversations ALTER COLUMN department_id SET NOT NULL;

ALTER TABLE flow_runs
  ADD COLUMN IF NOT EXISTS department_id UUID,
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;
UPDATE flow_runs r SET department_id = d.id
FROM departments d WHERE d.account_id = r.account_id AND d.is_default AND r.department_id IS NULL;
ALTER TABLE flow_runs ALTER COLUMN department_id SET NOT NULL;

ALTER TABLE automation_logs
  ADD COLUMN IF NOT EXISTS department_id UUID,
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;
UPDATE automation_logs r SET department_id = d.id
FROM departments d WHERE d.account_id = r.account_id AND d.is_default AND r.department_id IS NULL;
ALTER TABLE automation_logs ALTER COLUMN department_id SET NOT NULL;

ALTER TABLE automation_pending_executions
  ADD COLUMN IF NOT EXISTS department_id UUID,
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;
UPDATE automation_pending_executions r SET department_id = d.id
FROM departments d WHERE d.account_id = r.account_id AND d.is_default AND r.department_id IS NULL;
ALTER TABLE automation_pending_executions ALTER COLUMN department_id SET NOT NULL;

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS account_id UUID,
  ADD COLUMN IF NOT EXISTS department_id UUID,
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;
UPDATE broadcast_recipients r
SET account_id = b.account_id,
    department_id = COALESCE(r.department_id, d.id)
FROM broadcasts b
JOIN departments d ON d.account_id = b.account_id AND d.is_default
WHERE b.id = r.broadcast_id AND (r.account_id IS NULL OR r.department_id IS NULL);
ALTER TABLE broadcast_recipients ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE broadcast_recipients ALTER COLUMN department_id SET NOT NULL;

-- Migration 045 may create broadcast_jobs concurrently/in another release line.
DO $$
BEGIN
  IF to_regclass('public.broadcast_jobs') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE broadcast_jobs ADD COLUMN IF NOT EXISTS department_id UUID';
    EXECUTE 'ALTER TABLE broadcast_jobs ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL';
    EXECUTE 'UPDATE broadcast_jobs j SET department_id = d.id FROM departments d WHERE d.account_id = j.account_id AND d.is_default AND j.department_id IS NULL';
    EXECUTE 'ALTER TABLE broadcast_jobs ALTER COLUMN department_id SET NOT NULL';
  END IF;
END $$;

-- Composite FKs prevent a department from another account being stamped.
DO $$
DECLARE item RECORD;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('whatsapp_config','whatsapp_config_department_account_fk'),
    ('conversations','conversations_department_account_fk'),
    ('flow_runs','flow_runs_department_account_fk'),
    ('automation_logs','automation_logs_department_account_fk'),
    ('automation_pending_executions','automation_pending_department_account_fk'),
    ('broadcast_recipients','broadcast_recipients_department_account_fk')
  ) AS x(table_name, constraint_name)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = item.constraint_name) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (account_id, department_id) REFERENCES departments(account_id, id) ON DELETE RESTRICT', item.table_name, item.constraint_name);
    END IF;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS conversations_department_idx ON conversations(account_id, department_id);
CREATE INDEX IF NOT EXISTS flow_runs_department_idx ON flow_runs(account_id, department_id);
CREATE INDEX IF NOT EXISTS automation_logs_department_idx ON automation_logs(account_id, department_id);
CREATE INDEX IF NOT EXISTS automation_pending_department_idx ON automation_pending_executions(account_id, department_id);
CREATE INDEX IF NOT EXISTS broadcast_recipients_department_idx ON broadcast_recipients(account_id, department_id);
