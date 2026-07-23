-- ============================================================
-- 043_atomic_flow_automation_definition_saves.sql
--
-- Makes parent + child definition replacement a single PostgreSQL
-- transaction. These functions are callable only by service_role; route
-- handlers still enforce account role before invoking them.
-- ============================================================

CREATE OR REPLACE FUNCTION public.save_flow_definition_atomic(
  p_flow_id UUID,
  p_account_id UUID,
  p_patch JSONB,
  p_nodes JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_flow public.flows%ROWTYPE;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'p_patch must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF p_nodes IS NOT NULL AND jsonb_typeof(p_nodes) <> 'array' THEN
    RAISE EXCEPTION 'p_nodes must be a JSON array or null' USING ERRCODE = '22023';
  END IF;

  UPDATE public.flows
  SET
    name = CASE WHEN p_patch ? 'name' THEN p_patch->>'name' ELSE name END,
    description = CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE description END,
    trigger_type = CASE WHEN p_patch ? 'trigger_type' THEN p_patch->>'trigger_type' ELSE trigger_type END,
    trigger_config = CASE WHEN p_patch ? 'trigger_config' THEN p_patch->'trigger_config' ELSE trigger_config END,
    entry_node_id = CASE WHEN p_patch ? 'entry_node_id' THEN p_patch->>'entry_node_id' ELSE entry_node_id END,
    fallback_policy = CASE WHEN p_patch ? 'fallback_policy' THEN p_patch->'fallback_policy' ELSE fallback_policy END,
    updated_at = NOW()
  WHERE id = p_flow_id
    AND account_id = p_account_id
  RETURNING * INTO v_flow;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'flow not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_nodes IS NOT NULL THEN
    DELETE FROM public.flow_nodes WHERE flow_id = p_flow_id;
    INSERT INTO public.flow_nodes (
      flow_id, node_key, node_type, config, position_x, position_y
    )
    SELECT
      p_flow_id,
      node->>'node_key',
      node->>'node_type',
      COALESCE(node->'config', '{}'::jsonb),
      COALESCE((node->>'position_x')::integer, 0),
      COALESCE((node->>'position_y')::integer, 0)
    FROM jsonb_array_elements(p_nodes) AS node;
  END IF;

  RETURN to_jsonb(v_flow);
END;
$$;

CREATE OR REPLACE FUNCTION public.save_automation_definition_atomic(
  p_automation_id UUID,
  p_account_id UUID,
  p_patch JSONB,
  p_steps JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_automation public.automations%ROWTYPE;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'p_patch must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF p_steps IS NOT NULL AND jsonb_typeof(p_steps) <> 'array' THEN
    RAISE EXCEPTION 'p_steps must be a JSON array or null' USING ERRCODE = '22023';
  END IF;

  UPDATE public.automations
  SET
    name = CASE WHEN p_patch ? 'name' THEN p_patch->>'name' ELSE name END,
    description = CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE description END,
    trigger_type = CASE WHEN p_patch ? 'trigger_type' THEN p_patch->>'trigger_type' ELSE trigger_type END,
    trigger_config = CASE WHEN p_patch ? 'trigger_config' THEN p_patch->'trigger_config' ELSE trigger_config END,
    is_active = CASE WHEN p_patch ? 'is_active' THEN (p_patch->>'is_active')::boolean ELSE is_active END,
    updated_at = NOW()
  WHERE id = p_automation_id
    AND account_id = p_account_id
  RETURNING * INTO v_automation;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'automation not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_steps IS NOT NULL THEN
    DELETE FROM public.automation_steps WHERE automation_id = p_automation_id;
    INSERT INTO public.automation_steps (
      id, automation_id, parent_step_id, branch, step_type, step_config, position
    )
    SELECT
      (step->>'id')::uuid,
      p_automation_id,
      NULLIF(step->>'parent_step_id', '')::uuid,
      NULLIF(step->>'branch', ''),
      step->>'step_type',
      COALESCE(step->'step_config', '{}'::jsonb),
      (step->>'position')::integer
    FROM jsonb_array_elements(p_steps) AS step;
  END IF;

  RETURN to_jsonb(v_automation);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_flow_definition_atomic(
  p_user_id UUID,
  p_account_id UUID,
  p_definition JSONB,
  p_nodes JSONB DEFAULT '[]'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_flow public.flows%ROWTYPE;
BEGIN
  IF p_definition IS NULL OR jsonb_typeof(p_definition) <> 'object'
     OR p_nodes IS NULL OR jsonb_typeof(p_nodes) <> 'array' THEN
    RAISE EXCEPTION 'invalid flow definition payload' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.flows (
    user_id, account_id, name, description, status, trigger_type,
    trigger_config, entry_node_id, fallback_policy
  ) VALUES (
    p_user_id,
    p_account_id,
    p_definition->>'name',
    p_definition->>'description',
    COALESCE(p_definition->>'status', 'draft'),
    p_definition->>'trigger_type',
    COALESCE(p_definition->'trigger_config', '{}'::jsonb),
    p_definition->>'entry_node_id',
    COALESCE(p_definition->'fallback_policy', '{"on_unknown_reply":"reprompt","max_reprompts":2,"on_timeout_hours":24,"on_exhaust":"handoff"}'::jsonb)
  ) RETURNING * INTO v_flow;

  INSERT INTO public.flow_nodes (
    flow_id, node_key, node_type, config, position_x, position_y
  )
  SELECT
    v_flow.id,
    node->>'node_key',
    node->>'node_type',
    COALESCE(node->'config', '{}'::jsonb),
    COALESCE((node->>'position_x')::integer, 0),
    COALESCE((node->>'position_y')::integer, 0)
  FROM jsonb_array_elements(p_nodes) AS node;

  RETURN to_jsonb(v_flow);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_automation_definition_atomic(
  p_user_id UUID,
  p_account_id UUID,
  p_definition JSONB,
  p_steps JSONB DEFAULT '[]'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_automation public.automations%ROWTYPE;
BEGIN
  IF p_definition IS NULL OR jsonb_typeof(p_definition) <> 'object'
     OR p_steps IS NULL OR jsonb_typeof(p_steps) <> 'array' THEN
    RAISE EXCEPTION 'invalid automation definition payload' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.automations (
    user_id, account_id, name, description, trigger_type, trigger_config, is_active
  ) VALUES (
    p_user_id,
    p_account_id,
    p_definition->>'name',
    p_definition->>'description',
    p_definition->>'trigger_type',
    COALESCE(p_definition->'trigger_config', '{}'::jsonb),
    COALESCE((p_definition->>'is_active')::boolean, false)
  ) RETURNING * INTO v_automation;

  INSERT INTO public.automation_steps (
    id, automation_id, parent_step_id, branch, step_type, step_config, position
  )
  SELECT
    (step->>'id')::uuid,
    v_automation.id,
    NULLIF(step->>'parent_step_id', '')::uuid,
    NULLIF(step->>'branch', ''),
    step->>'step_type',
    COALESCE(step->'step_config', '{}'::jsonb),
    (step->>'position')::integer
  FROM jsonb_array_elements(p_steps) AS step;

  RETURN to_jsonb(v_automation);
END;
$$;

REVOKE ALL ON FUNCTION public.save_flow_definition_atomic(UUID, UUID, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_automation_definition_atomic(UUID, UUID, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_flow_definition_atomic(UUID, UUID, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_automation_definition_atomic(UUID, UUID, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_flow_definition_atomic(UUID, UUID, JSONB, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.save_automation_definition_atomic(UUID, UUID, JSONB, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.create_flow_definition_atomic(UUID, UUID, JSONB, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.create_automation_definition_atomic(UUID, UUID, JSONB, JSONB)
  TO service_role;
