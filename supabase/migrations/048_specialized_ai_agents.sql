-- P2-B: agentes especializados por conta. O modo padrão é draft_only;
-- auto_reply nunca é criado nem selecionado implicitamente.

-- Esta migration altera whatsapp_config e conversations, que já têm dados de
-- clientes reais. ALTER TABLE ... ADD CONSTRAINT UNIQUE pega ACCESS EXCLUSIVE e
-- segura o lock pela transação inteira. conversations é a tabela mais quente do
-- CRM (todo webhook inbound a toca): se alguma query longa ou uma conexão
-- "idle in transaction" já estiver segurando lock nela, o ALTER entra na fila e
-- toda query seguinte empilha atrás dele — apagão indefinido em vez de erro.
-- Com lock_timeout a migration falha rápido e reversível; basta repetir depois.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS ai_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Agente de IA — Não configurado',
  description text,
  mode text NOT NULL DEFAULT 'draft_only'
    CHECK (mode IN ('disabled', 'draft_only', 'supervised', 'auto_reply')),
  system_prompt text,
  knowledge_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  daily_reply_cap integer NOT NULL DEFAULT 50 CHECK (daily_reply_cap BETWEEN 0 AND 10000),
  monthly_budget_cents integer NOT NULL DEFAULT 0 CHECK (monthly_budget_cents >= 0),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_agents_one_default_per_account
  ON ai_agents(account_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS ai_agents_account_idx ON ai_agents(account_id, is_active);

-- whatsapp_config e conversations nascem em migrations já aplicadas e não podem
-- ser reescritas; sem UNIQUE (account_id, id) o Postgres recusa as FKs compostas
-- abaixo. PostgreSQL não tem "ADD CONSTRAINT IF NOT EXISTS", então guarda-se via
-- pg_constraint. (account_id, id) já é único de fato porque id é a PK.
DO $$
DECLARE item RECORD;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('whatsapp_config', 'whatsapp_config_account_id_id_key'),
    ('conversations', 'conversations_account_id_id_key')
  ) AS x(table_name, constraint_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = item.constraint_name
        AND conrelid = ('public.' || item.table_name)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE (account_id, id)',
        item.table_name, item.constraint_name
      );
    END IF;
  END LOOP;
END $$;
-- Só o bloco acima toca tabelas com dados; o resto cria tabelas novas.
RESET lock_timeout;

CREATE TABLE IF NOT EXISTS ai_agent_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  whatsapp_config_id uuid,
  department_id uuid,
  priority integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, agent_id) REFERENCES ai_agents(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, whatsapp_config_id) REFERENCES whatsapp_config(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, department_id) REFERENCES departments(account_id, id) ON DELETE RESTRICT,
  CHECK (whatsapp_config_id IS NOT NULL OR department_id IS NOT NULL),
  UNIQUE (account_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_binding_scope_unique ON ai_agent_bindings(
  account_id,
  COALESCE(whatsapp_config_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE is_active;

CREATE TABLE IF NOT EXISTS conversation_agent_state (
  conversation_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sticky_agent_id uuid,
  handoff_status text NOT NULL DEFAULT 'none'
    CHECK (handoff_status IN ('none', 'requested', 'accepted', 'released')),
  handoff_reason text,
  handoff_at timestamptz,
  reply_count integer NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
  budget_reserved_cents integer NOT NULL DEFAULT 0 CHECK (budget_reserved_cents >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE CASCADE,
  -- PostgreSQL 15+ aceita lista de colunas em SET NULL: a FK fica composta
  -- (isolamento por conta) sem tentar anular account_id, que é NOT NULL.
  FOREIGN KEY (account_id, sticky_agent_id) REFERENCES ai_agents(account_id, id)
    ON DELETE SET NULL (sticky_agent_id)
);

CREATE TABLE IF NOT EXISTS ai_agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid,
  agent_id uuid NOT NULL,
  binding_id uuid,
  whatsapp_config_id uuid,
  department_id uuid,
  route_source text NOT NULL
    CHECK (route_source IN ('sticky', 'config_department', 'config', 'department', 'default')),
  mode text NOT NULL CHECK (mode IN ('disabled', 'draft_only', 'supervised', 'auto_reply')),
  status text NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'generated', 'awaiting_approval', 'sent', 'blocked', 'handoff', 'failed')),
  reserved_cost_cents integer NOT NULL DEFAULT 0 CHECK (reserved_cost_cents >= 0),
  actual_cost_cents integer CHECK (actual_cost_cents >= 0),
  provider text,
  model text,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, agent_id) REFERENCES ai_agents(account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id)
    ON DELETE SET NULL (conversation_id),
  FOREIGN KEY (account_id, binding_id) REFERENCES ai_agent_bindings(account_id, id)
    ON DELETE SET NULL (binding_id),
  UNIQUE (account_id, id)
);
CREATE INDEX IF NOT EXISTS ai_agent_runs_account_created_idx
  ON ai_agent_runs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_agent_runs_budget_idx
  ON ai_agent_runs(account_id, agent_id, started_at DESC);

CREATE TABLE IF NOT EXISTS ai_agent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_id uuid,
  agent_id uuid,
  conversation_id uuid,
  event_type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, run_id) REFERENCES ai_agent_runs(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, agent_id) REFERENCES ai_agents(account_id, id)
    ON DELETE SET NULL (agent_id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id)
    ON DELETE SET NULL (conversation_id)
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ai_agents', 'ai_agent_bindings', 'conversation_agent_state',
    'ai_agent_runs', 'ai_agent_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;

DROP POLICY IF EXISTS ai_agents_read ON ai_agents;
CREATE POLICY ai_agents_read ON ai_agents FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS ai_agents_write ON ai_agents;
CREATE POLICY ai_agents_write ON ai_agents FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_agent_bindings_read ON ai_agent_bindings;
CREATE POLICY ai_agent_bindings_read ON ai_agent_bindings FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS ai_agent_bindings_write ON ai_agent_bindings;
CREATE POLICY ai_agent_bindings_write ON ai_agent_bindings FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS conversation_agent_state_read ON conversation_agent_state;
CREATE POLICY conversation_agent_state_read ON conversation_agent_state FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS ai_agent_runs_read ON ai_agent_runs;
CREATE POLICY ai_agent_runs_read ON ai_agent_runs FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS ai_agent_events_read ON ai_agent_events;
CREATE POLICY ai_agent_events_read ON ai_agent_events FOR SELECT USING (is_account_member(account_id));
REVOKE INSERT, UPDATE, DELETE ON conversation_agent_state, ai_agent_runs, ai_agent_events
  FROM anon, authenticated;

-- Roteamento determinístico: sticky > configuração+departamento > configuração
-- > departamento > default. Empates na melhor posição falham fechados.
CREATE OR REPLACE FUNCTION resolve_ai_agent_binding(
  p_account_id uuid,
  p_whatsapp_config_id uuid,
  p_department_id uuid,
  p_sticky_agent_id uuid DEFAULT NULL
) RETURNS TABLE (
  agent_id uuid,
  binding_id uuid,
  route_source text,
  mode text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE top_rank integer; top_priority integer; winner_count integer;
BEGIN
  IF p_sticky_agent_id IS NOT NULL THEN
    RETURN QUERY
      SELECT a.id, NULL::uuid, 'sticky'::text, a.mode
      FROM ai_agents a
      WHERE a.id = p_sticky_agent_id AND a.account_id = p_account_id
        AND a.is_active AND a.mode <> 'disabled';
    IF FOUND THEN RETURN; END IF;
  END IF;

  WITH ranked AS (
    SELECT a.id AS candidate_agent_id, b.id AS candidate_binding_id, a.mode AS candidate_mode,
      CASE
        WHEN b.whatsapp_config_id = p_whatsapp_config_id AND b.department_id = p_department_id
          AND p_whatsapp_config_id IS NOT NULL AND p_department_id IS NOT NULL THEN 4
        WHEN b.whatsapp_config_id = p_whatsapp_config_id AND b.department_id IS NULL
          AND p_whatsapp_config_id IS NOT NULL THEN 3
        WHEN b.department_id = p_department_id AND b.whatsapp_config_id IS NULL
          AND p_department_id IS NOT NULL THEN 2
        WHEN a.is_default AND b.id IS NULL THEN 1
        ELSE 0
      END AS rank_value,
      COALESCE(b.priority, 0) AS priority_value
    FROM ai_agents a
    LEFT JOIN ai_agent_bindings b
      ON b.agent_id = a.id AND b.account_id = p_account_id AND b.is_active
    WHERE a.account_id = p_account_id AND a.is_active AND a.mode <> 'disabled'
  ), best AS (
    SELECT * FROM ranked WHERE rank_value > 0
    ORDER BY rank_value DESC, priority_value DESC, candidate_agent_id LIMIT 1
  ) SELECT rank_value, priority_value INTO top_rank, top_priority FROM best;

  IF top_rank IS NULL THEN RETURN; END IF;

  WITH ranked AS (
    SELECT a.id,
      CASE
        WHEN b.whatsapp_config_id = p_whatsapp_config_id AND b.department_id = p_department_id
          AND p_whatsapp_config_id IS NOT NULL AND p_department_id IS NOT NULL THEN 4
        WHEN b.whatsapp_config_id = p_whatsapp_config_id AND b.department_id IS NULL
          AND p_whatsapp_config_id IS NOT NULL THEN 3
        WHEN b.department_id = p_department_id AND b.whatsapp_config_id IS NULL
          AND p_department_id IS NOT NULL THEN 2
        WHEN a.is_default AND b.id IS NULL THEN 1 ELSE 0 END AS rank_value,
      COALESCE(b.priority, 0) AS priority_value
    FROM ai_agents a LEFT JOIN ai_agent_bindings b
      ON b.agent_id = a.id AND b.account_id = p_account_id AND b.is_active
    WHERE a.account_id = p_account_id AND a.is_active AND a.mode <> 'disabled'
  ) SELECT count(*) INTO winner_count FROM ranked
    WHERE rank_value = top_rank AND priority_value = top_priority;
  IF winner_count > 1 THEN RAISE EXCEPTION 'ambiguous_agent_binding'; END IF;

  RETURN QUERY
  WITH ranked AS (
    SELECT a.id AS candidate_agent_id, b.id AS candidate_binding_id, a.mode AS candidate_mode,
      CASE
        WHEN b.whatsapp_config_id = p_whatsapp_config_id AND b.department_id = p_department_id
          AND p_whatsapp_config_id IS NOT NULL AND p_department_id IS NOT NULL THEN 4
        WHEN b.whatsapp_config_id = p_whatsapp_config_id AND b.department_id IS NULL
          AND p_whatsapp_config_id IS NOT NULL THEN 3
        WHEN b.department_id = p_department_id AND b.whatsapp_config_id IS NULL
          AND p_department_id IS NOT NULL THEN 2
        WHEN a.is_default AND b.id IS NULL THEN 1 ELSE 0 END AS rank_value,
      COALESCE(b.priority, 0) AS priority_value
    FROM ai_agents a LEFT JOIN ai_agent_bindings b
      ON b.agent_id = a.id AND b.account_id = p_account_id AND b.is_active
    WHERE a.account_id = p_account_id AND a.is_active AND a.mode <> 'disabled'
  )
  SELECT candidate_agent_id, candidate_binding_id,
    CASE top_rank WHEN 4 THEN 'config_department' WHEN 3 THEN 'config'
      WHEN 2 THEN 'department' ELSE 'default' END,
    candidate_mode
  FROM ranked WHERE rank_value = top_rank AND priority_value = top_priority LIMIT 1;
END $$;
REVOKE ALL ON FUNCTION resolve_ai_agent_binding(uuid, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resolve_ai_agent_binding(uuid, uuid, uuid, uuid) TO service_role;

-- Reserva atômica antes de qualquer chamada de provedor. O cap é diário por
-- agente/conta e o orçamento é mensal por agente/conta, não por conversa.
CREATE OR REPLACE FUNCTION claim_ai_agent_budget(
  p_account_id uuid,
  p_conversation_id uuid,
  p_agent_id uuid,
  p_binding_id uuid,
  p_whatsapp_config_id uuid,
  p_department_id uuid,
  p_route_source text,
  p_estimated_cost_cents integer
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  selected_agent ai_agents;
  selected_state conversation_agent_state;
  daily_count integer;
  monthly_reserved bigint;
  run_id uuid;
BEGIN
  IF p_estimated_cost_cents < 0 THEN RAISE EXCEPTION 'invalid_estimated_cost'; END IF;
  IF p_route_source NOT IN ('sticky', 'config_department', 'config', 'department', 'default') THEN
    RAISE EXCEPTION 'invalid_route_source';
  END IF;

  SELECT * INTO selected_agent FROM ai_agents
    WHERE id = p_agent_id AND account_id = p_account_id AND is_active AND mode = 'auto_reply'
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent_unavailable'; END IF;

  IF p_binding_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ai_agent_bindings
    WHERE id = p_binding_id AND account_id = p_account_id
      AND agent_id = p_agent_id AND is_active
  ) THEN RAISE EXCEPTION 'binding_not_owned'; END IF;
  IF p_whatsapp_config_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM whatsapp_config
    WHERE id = p_whatsapp_config_id AND account_id = p_account_id AND disabled_at IS NULL
  ) THEN RAISE EXCEPTION 'whatsapp_config_not_owned'; END IF;
  IF p_department_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM departments WHERE id = p_department_id AND account_id = p_account_id
  ) THEN RAISE EXCEPTION 'department_not_owned'; END IF;

  INSERT INTO conversation_agent_state(conversation_id, account_id, sticky_agent_id)
    SELECT c.id, c.account_id, p_agent_id FROM conversations c
    WHERE c.id = p_conversation_id AND c.account_id = p_account_id
      AND (p_department_id IS NULL OR c.department_id = p_department_id)
    ON CONFLICT (conversation_id) DO NOTHING;
  SELECT * INTO selected_state FROM conversation_agent_state
    WHERE conversation_id = p_conversation_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_owned'; END IF;
  IF selected_state.handoff_status IN ('requested', 'accepted') THEN
    RAISE EXCEPTION 'handoff_active';
  END IF;

  SELECT count(*) INTO daily_count FROM ai_agent_runs
    WHERE account_id = p_account_id AND agent_id = p_agent_id
      AND started_at >= date_trunc('day', now())
      AND status NOT IN ('blocked', 'failed');
  IF daily_count >= selected_agent.daily_reply_cap THEN RAISE EXCEPTION 'daily_reply_cap_exceeded'; END IF;

  SELECT COALESCE(sum(reserved_cost_cents), 0) INTO monthly_reserved FROM ai_agent_runs
    WHERE account_id = p_account_id AND agent_id = p_agent_id
      AND started_at >= date_trunc('month', now())
      AND status <> 'blocked';
  IF selected_agent.monthly_budget_cents > 0
     AND monthly_reserved + p_estimated_cost_cents > selected_agent.monthly_budget_cents THEN
    RAISE EXCEPTION 'monthly_budget_exceeded';
  END IF;

  UPDATE conversation_agent_state SET
    sticky_agent_id = p_agent_id,
    reply_count = reply_count + 1,
    budget_reserved_cents = budget_reserved_cents + p_estimated_cost_cents,
    updated_at = now()
  WHERE conversation_id = p_conversation_id AND account_id = p_account_id;

  INSERT INTO ai_agent_runs(
    account_id, conversation_id, agent_id, binding_id, whatsapp_config_id,
    department_id, route_source, mode, reserved_cost_cents
  ) VALUES (
    p_account_id, p_conversation_id, p_agent_id, p_binding_id,
    p_whatsapp_config_id, p_department_id, p_route_source,
    selected_agent.mode, p_estimated_cost_cents
  ) RETURNING id INTO run_id;
  INSERT INTO ai_agent_events(account_id, run_id, agent_id, conversation_id, event_type, detail)
  VALUES (p_account_id, run_id, p_agent_id, p_conversation_id, 'budget_claimed',
    jsonb_build_object(
      'estimated_cost_cents', p_estimated_cost_cents,
      'route_source', p_route_source,
      'binding_id', p_binding_id,
      'whatsapp_config_id', p_whatsapp_config_id,
      'department_id', p_department_id
    ));
  RETURN run_id;
END $$;
REVOKE ALL ON FUNCTION claim_ai_agent_budget(uuid, uuid, uuid, uuid, uuid, uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_ai_agent_budget(uuid, uuid, uuid, uuid, uuid, uuid, text, integer) TO service_role;

-- Service-role-only lifecycle transition. `p_expected_status` is the fencing
-- token: stale workers cannot overwrite a run advanced by another claimant.
CREATE OR REPLACE FUNCTION finish_ai_agent_run(
  p_account_id uuid,
  p_run_id uuid,
  p_expected_status text,
  p_status text,
  p_provider text DEFAULT NULL,
  p_model text DEFAULT NULL,
  p_error_code text DEFAULT NULL,
  p_error_message text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  changed integer;
  selected_run ai_agent_runs;
BEGIN
  IF p_status NOT IN ('generated', 'sent', 'handoff', 'failed') THEN
    RAISE EXCEPTION 'invalid_agent_run_status';
  END IF;
  IF NOT (
    (p_expected_status = 'claimed' AND p_status IN ('generated', 'failed')) OR
    (p_expected_status = 'generated' AND p_status IN ('sent', 'handoff', 'failed'))
  ) THEN
    RAISE EXCEPTION 'invalid_agent_run_transition';
  END IF;

  UPDATE ai_agent_runs SET
    status = p_status,
    provider = COALESCE(p_provider, provider),
    model = COALESCE(p_model, model),
    error_code = CASE WHEN p_status = 'failed' THEN p_error_code ELSE NULL END,
    error_message = CASE WHEN p_status = 'failed' THEN left(p_error_message, 2000) ELSE NULL END,
    finished_at = CASE WHEN p_status IN ('sent', 'handoff', 'failed') THEN now() ELSE NULL END
  WHERE id = p_run_id
    AND account_id = p_account_id
    AND status = p_expected_status
  RETURNING * INTO selected_run;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RETURN false; END IF;

  INSERT INTO ai_agent_events(
    account_id, run_id, agent_id, conversation_id, event_type, detail
  ) VALUES (
    p_account_id, selected_run.id, selected_run.agent_id,
    selected_run.conversation_id, 'run_' || p_status,
    jsonb_strip_nulls(jsonb_build_object(
      'previous_status', p_expected_status,
      'error_code', p_error_code,
      'error_message', left(p_error_message, 2000)
    ))
  );
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION finish_ai_agent_run(uuid, uuid, text, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION finish_ai_agent_run(uuid, uuid, text, text, text, text, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION set_ai_agent_handoff(
  p_account_id uuid,
  p_conversation_id uuid,
  p_status text,
  p_reason text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed integer;
BEGIN
  IF p_status NOT IN ('requested', 'accepted', 'released') THEN
    RAISE EXCEPTION 'invalid_handoff_status';
  END IF;
  INSERT INTO conversation_agent_state(conversation_id, account_id)
    SELECT id, account_id FROM conversations
    WHERE id = p_conversation_id AND account_id = p_account_id
    ON CONFLICT (conversation_id) DO NOTHING;
  UPDATE conversation_agent_state SET
    handoff_status = p_status,
    handoff_reason = CASE WHEN p_status = 'released' THEN NULL ELSE nullif(trim(p_reason), '') END,
    handoff_at = now(),
    updated_at = now()
  WHERE conversation_id = p_conversation_id AND account_id = p_account_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'conversation_not_owned'; END IF;
  INSERT INTO ai_agent_events(account_id, conversation_id, event_type, detail)
  VALUES (p_account_id, p_conversation_id, 'handoff_' || p_status,
    jsonb_build_object('reason', p_reason));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION set_ai_agent_handoff(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_ai_agent_handoff(uuid, uuid, text, text) TO service_role;

-- Seed neutro para todos. A persona Secretária de IA NEXOR pertence
-- exclusivamente ao perfil autenticado andersonmenttor@gmail.com; o nome da
-- conta não é prova suficiente de identidade e não pode ativar a persona.
INSERT INTO ai_agents(account_id, name, mode, is_default, is_active, system_prompt)
SELECT a.id, 'Agente de IA — Não configurado', 'draft_only', true, true, NULL
FROM accounts a
WHERE NOT EXISTS (
  SELECT 1 FROM ai_agents existing WHERE existing.account_id = a.id AND existing.is_default
);
UPDATE ai_agents agent
SET name = 'Secretária de IA NEXOR'
WHERE agent.is_default
  AND EXISTS (
    SELECT 1
    FROM profiles profile
    JOIN auth.users auth_user ON auth_user.id = profile.id
    WHERE profile.account_id = agent.account_id
      AND lower(auth_user.email) = 'andersonmenttor@gmail.com'
  );
