-- Detecta em qual migration o schema desta instalação realmente parou.
--
-- Existe porque o README pede para "comparar o schema com supabase/migrations/,
-- do arquivo de maior número para o menor" — trabalho manual e sujeito a erro,
-- num passo onde o número errado é destrutivo. Cada linha testa um objeto que
-- só existe se aquela migration rodou.
--
-- Uso (a partir da raiz do repositório):
--   psql "postgresql://postgres:SENHA@db.SEU-REF.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=$PWD/prod-ca-2021.crt" \
--     -f scripts/migration-check/detectar-baseline.sql
--
-- Leitura do resultado: o baseline correto é o MAIOR número com "APLICADA"
-- imediatamente antes da primeira "faltando". Se aparecer "APLICADA" depois de
-- uma "faltando", pare — o schema está inconsistente e nenhum --baseline é
-- seguro sem investigar antes.

with checagens(migration, objeto, existe) as (
  values
    ('040_evolution_webhook_inbox',
     'tabela evolution_webhook_events',
     to_regclass('public.evolution_webhook_events') is not null),

    ('041_whatsapp_service_experience',
     'coluna contacts.whatsapp_push_name',
     exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='contacts'
               and column_name='whatsapp_push_name')),

    ('042_evolution_hardening_consistency',
     'coluna evolution_webhook_events.dead_letter_at',
     exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='evolution_webhook_events'
               and column_name='dead_letter_at')),

    ('043_atomic_flow_automation_definition_saves',
     'função save_flow_definition_atomic',
     exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname='save_flow_definition_atomic')),

    ('044_private_chat_media',
     'policy "Account members can read chat media" em storage.objects',
     exists (select 1 from pg_policies
             where schemaname='storage' and tablename='objects'
               and policyname='Account members can read chat media')),

    ('045_external_operations_outbox',
     'tabela external_operations',
     to_regclass('public.external_operations') is not null),

    ('046_departments_multi_instance_foundation',
     'tabela departments',
     to_regclass('public.departments') is not null),

    ('047_multi_instance_cutover',
     'coluna whatsapp_config.department_id',
     exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='whatsapp_config'
               and column_name='department_id')),

    ('048_specialized_ai_agents',
     'tabela ai_agents',
     to_regclass('public.ai_agents') is not null),

    ('049_async_transcription',
     'tabela transcription_jobs',
     to_regclass('public.transcription_jobs') is not null),

    ('050_manual_assisted_channels',
     'tabela channels',
     to_regclass('public.channels') is not null)
)
select
  migration,
  case when existe then 'APLICADA' else '-- faltando' end as situacao,
  objeto
from checagens
order by migration;

-- `--baseline` decide pela QUANTIDADE DE REGISTROS, não pela existência da
-- tabela (migrate.mjs: `if (appliedRecords.length > 0)`). A distinção não é
-- teórica: `ensureMigrationsTable` roda `create table if not exists` logo no
-- começo de QUALQUER execução, inclusive `--dry-run`. Ou seja, depois do
-- primeiro dry-run a tabela existe e está vazia — e uma checagem por existência
-- diz "não use --baseline" exatamente quando --baseline é o comando correto.
--
-- query_to_xml recebe a consulta como texto e só é avaliada em tempo de
-- execução, dentro do ramo do CASE. Referenciar public.schema_migrations
-- diretamente aqui faria a consulta inteira falhar no parse quando a tabela não
-- existe — que é metade dos casos que este rodapé precisa distinguir.
select
  case
    when to_regclass('public.schema_migrations') is null then
      'schema_migrations NAO existe — instalação manual: use --baseline NNN'
    when (
      xpath(
        '/row/cnt/text()',
        query_to_xml(
          'select count(*) as cnt from public.schema_migrations',
          false, true, ''
        )
      )
    )[1]::text::bigint = 0 then
      'schema_migrations existe mas esta VAZIA (0 registros) — use --baseline NNN. '
      || 'A tabela vazia e efeito colateral normal de um --dry-run anterior.'
    else
      'schema_migrations JA TEM registros — NAO use --baseline; rode sem flags'
  end as tabela_de_controle;
