-- Prova FUNCIONAL do isolamento multi-tenant: o banco deve RECUSAR qualquer
-- referência que atravesse contas. Cada bloco espera uma exceção; se algum
-- INSERT passar, a migration não está protegendo o que promete.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

INSERT INTO accounts(id, name, owner_user_id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Conta A', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Conta B', '22222222-2222-2222-2222-222222222222');

INSERT INTO departments(id, account_id, name) VALUES
  ('dddddddd-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', 'Dept A'),
  ('dddddddd-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-000000000002', 'Dept B');

INSERT INTO ai_agents(id, account_id, name) VALUES
  ('eeeeeeee-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', 'Agente A'),
  ('eeeeeeee-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-000000000002', 'Agente B');

CREATE OR REPLACE FUNCTION pg_temp.deve_falhar(rotulo text, sql text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'BLOQUEADO (correto) | %', rotulo;
    RETURN;
  END;
  RAISE EXCEPTION 'VAZAMENTO | % | o banco ACEITOU referencia entre contas', rotulo;
END $$;

-- 1. binding da conta A apontando para agente da conta B
SELECT pg_temp.deve_falhar('ai_agent_bindings.agent_id cruzando conta', $q$
  INSERT INTO ai_agent_bindings(account_id, agent_id, department_id)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'eeeeeeee-0000-0000-0000-00000000000b',
          'dddddddd-0000-0000-0000-00000000000a')
$q$);

-- 2. binding da conta A apontando para departamento da conta B
SELECT pg_temp.deve_falhar('ai_agent_bindings.department_id cruzando conta', $q$
  INSERT INTO ai_agent_bindings(account_id, agent_id, department_id)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'eeeeeeee-0000-0000-0000-00000000000a',
          'dddddddd-0000-0000-0000-00000000000b')
$q$);

-- 3. run da conta A atribuido a agente da conta B
SELECT pg_temp.deve_falhar('ai_agent_runs.agent_id cruzando conta', $q$
  INSERT INTO ai_agent_runs(account_id, agent_id, route_source, mode)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'eeeeeeee-0000-0000-0000-00000000000b', 'default', 'auto_reply')
$q$);

-- 4. canal da conta A em departamento da conta B  (migration 050)
SELECT pg_temp.deve_falhar('channels.department_id cruzando conta', $q$
  INSERT INTO channels(account_id, department_id, name)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
          'dddddddd-0000-0000-0000-00000000000b', 'Canal A')
$q$);

-- Controle positivo: a referencia legitima, dentro da MESMA conta, tem de passar.
INSERT INTO ai_agent_bindings(account_id, agent_id, department_id)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001',
        'eeeeeeee-0000-0000-0000-00000000000a',
        'dddddddd-0000-0000-0000-00000000000a');
\echo 'CONTROLE POSITIVO: referencia dentro da mesma conta foi ACEITA (correto)'

ROLLBACK;
