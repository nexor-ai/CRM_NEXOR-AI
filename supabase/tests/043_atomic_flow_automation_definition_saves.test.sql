\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  account_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft',
  trigger_type text NOT NULL,
  trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  entry_node_id text,
  fallback_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  execution_count integer NOT NULL DEFAULT 0,
  last_executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE flow_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  node_key text NOT NULL,
  node_type text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  position_x integer NOT NULL DEFAULT 0,
  position_y integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(flow_id, node_key)
);
CREATE TABLE automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  account_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  trigger_type text NOT NULL,
  trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT false,
  execution_count integer NOT NULL DEFAULT 0,
  last_executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE automation_steps (
  id uuid PRIMARY KEY,
  automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  parent_step_id uuid REFERENCES automation_steps(id) ON DELETE CASCADE,
  branch text CHECK (branch IN ('yes','no')),
  step_type text NOT NULL,
  step_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

\i /tmp/043.sql

DO $$
DECLARE
  account_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  account_b uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  user_a uuid := '11111111-1111-1111-1111-111111111111';
  v_flow_id uuid := '22222222-2222-2222-2222-222222222222';
  v_automation_id uuid := '33333333-3333-3333-3333-333333333333';
  v_parent_id uuid := '44444444-4444-4444-4444-444444444444';
  v_child_id uuid := '55555555-5555-5555-5555-555555555555';
  before_count integer;
BEGIN
  INSERT INTO flows(id,user_id,account_id,name,trigger_type)
  VALUES(v_flow_id,user_a,account_a,'Before','keyword');
  INSERT INTO flow_nodes(flow_id,node_key,node_type) VALUES(v_flow_id,'old','start');

  PERFORM save_flow_definition_atomic(
    v_flow_id, account_a, '{"name":"Atomic"}'::jsonb,
    '[{"node_key":"new","node_type":"start","config":{},"position_x":1,"position_y":2}]'::jsonb
  );
  IF (SELECT name FROM flows WHERE id=v_flow_id) <> 'Atomic' THEN RAISE EXCEPTION 'flow update failed'; END IF;
  IF (SELECT count(*) FROM flow_nodes WHERE flow_id=v_flow_id AND node_key='new') <> 1 THEN RAISE EXCEPTION 'flow nodes replace failed'; END IF;

  BEGIN
    PERFORM save_flow_definition_atomic(
      v_flow_id, account_a, '{"name":"Broken"}'::jsonb,
      '[{"node_key":"dup","node_type":"start"},{"node_key":"dup","node_type":"start"}]'::jsonb
    );
    RAISE EXCEPTION 'invalid flow save unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF (SELECT name FROM flows WHERE id=v_flow_id) <> 'Atomic' THEN RAISE EXCEPTION 'flow parent rollback failed'; END IF;
  IF (SELECT count(*) FROM flow_nodes WHERE flow_id=v_flow_id AND node_key='new') <> 1 THEN RAISE EXCEPTION 'flow children rollback failed'; END IF;

  BEGIN
    PERFORM save_flow_definition_atomic(v_flow_id, account_b, '{"name":"Cross"}'::jsonb, NULL);
    RAISE EXCEPTION 'cross-account flow save unexpectedly succeeded';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  IF (SELECT name FROM flows WHERE id=v_flow_id) <> 'Atomic' THEN RAISE EXCEPTION 'cross-account flow mutation'; END IF;

  INSERT INTO automations(id,user_id,account_id,name,trigger_type)
  VALUES(v_automation_id,user_a,account_a,'Before','new_message_received');
  INSERT INTO automation_steps(id,automation_id,step_type,position)
  VALUES(v_parent_id,v_automation_id,'send_message',0);

  PERFORM save_automation_definition_atomic(
    v_automation_id, account_a, '{"name":"Atomic"}'::jsonb,
    jsonb_build_array(
      jsonb_build_object('id',v_parent_id,'parent_step_id',NULL,'branch',NULL,'step_type','condition','step_config','{}'::jsonb,'position',0),
      jsonb_build_object('id',v_child_id,'parent_step_id',v_parent_id,'branch','yes','step_type','send_message','step_config','{}'::jsonb,'position',0)
    )
  );
  IF (SELECT name FROM automations WHERE id=v_automation_id) <> 'Atomic' THEN RAISE EXCEPTION 'automation update failed'; END IF;
  IF (SELECT count(*) FROM automation_steps WHERE automation_id=v_automation_id) <> 2 THEN RAISE EXCEPTION 'automation steps replace failed'; END IF;

  SELECT count(*) INTO before_count FROM automation_steps WHERE automation_id=v_automation_id;
  BEGIN
    PERFORM save_automation_definition_atomic(
      v_automation_id, account_a, '{"name":"Broken"}'::jsonb,
      jsonb_build_array(
        jsonb_build_object('id',v_parent_id,'parent_step_id',NULL,'branch',NULL,'step_type','send_message','step_config','{}'::jsonb,'position',0),
        jsonb_build_object('id',v_parent_id,'parent_step_id',NULL,'branch',NULL,'step_type','send_message','step_config','{}'::jsonb,'position',1)
      )
    );
    RAISE EXCEPTION 'invalid automation save unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF (SELECT name FROM automations WHERE id=v_automation_id) <> 'Atomic' THEN RAISE EXCEPTION 'automation parent rollback failed'; END IF;
  IF (SELECT count(*) FROM automation_steps WHERE automation_id=v_automation_id) <> before_count THEN RAISE EXCEPTION 'automation steps rollback failed'; END IF;

  PERFORM create_flow_definition_atomic(
    user_a, account_a,
    '{"name":"Created atomically","status":"draft","trigger_type":"keyword"}'::jsonb,
    '[{"node_key":"start","node_type":"start"}]'::jsonb
  );
  IF (SELECT count(*) FROM flows WHERE account_id=account_a AND name='Created atomically') <> 1 THEN
    RAISE EXCEPTION 'atomic flow create failed';
  END IF;
  BEGIN
    PERFORM create_flow_definition_atomic(
      user_a, account_a,
      '{"name":"Must rollback","status":"draft","trigger_type":"keyword"}'::jsonb,
      '[{"node_key":"dup","node_type":"start"},{"node_key":"dup","node_type":"start"}]'::jsonb
    );
    RAISE EXCEPTION 'invalid atomic flow create unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM flows WHERE account_id=account_a AND name='Must rollback') THEN
    RAISE EXCEPTION 'atomic flow create rollback failed';
  END IF;

  PERFORM create_automation_definition_atomic(
    user_a, account_a,
    '{"name":"Created atomically","trigger_type":"new_message_received"}'::jsonb,
    jsonb_build_array(
      jsonb_build_object('id',gen_random_uuid(),'parent_step_id',NULL,'branch',NULL,'step_type','send_message','step_config','{}'::jsonb,'position',0)
    )
  );
  IF (SELECT count(*) FROM automations WHERE account_id=account_a AND name='Created atomically') <> 1 THEN
    RAISE EXCEPTION 'atomic automation create failed';
  END IF;
  BEGIN
    PERFORM create_automation_definition_atomic(
      user_a, account_a,
      '{"name":"Must rollback","trigger_type":"new_message_received"}'::jsonb,
      jsonb_build_array(
        jsonb_build_object('id',v_parent_id,'parent_step_id',NULL,'branch',NULL,'step_type','send_message','step_config','{}'::jsonb,'position',0),
        jsonb_build_object('id',v_parent_id,'parent_step_id',NULL,'branch',NULL,'step_type','send_message','step_config','{}'::jsonb,'position',1)
      )
    );
    RAISE EXCEPTION 'invalid atomic automation create unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM automations WHERE account_id=account_a AND name='Must rollback') THEN
    RAISE EXCEPTION 'atomic automation create rollback failed';
  END IF;
END $$;

DO $$
BEGIN
  IF has_function_privilege('anon', 'save_flow_definition_atomic(uuid,uuid,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute flow save';
  END IF;
  IF has_function_privilege('authenticated', 'save_automation_definition_atomic(uuid,uuid,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute automation save';
  END IF;
  IF NOT has_function_privilege('service_role', 'save_flow_definition_atomic(uuid,uuid,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lacks flow execute';
  END IF;
  IF has_function_privilege('authenticated', 'create_flow_definition_atomic(uuid,uuid,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can execute flow create';
  END IF;
  IF has_function_privilege('anon', 'create_automation_definition_atomic(uuid,uuid,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute automation create';
  END IF;
  IF NOT has_function_privilege('service_role', 'create_automation_definition_atomic(uuid,uuid,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lacks automation create execute';
  END IF;
END $$;

SELECT 'ATOMIC_RPC_TEST_PASS' AS result;
