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

-- A tabela de controle já existe? Se sim, --baseline vai recusar rodar.
--
-- Sem subconsulta em public.schema_migrations: o Postgres resolve referências a
-- tabelas no parse, antes de avaliar o CASE, então citar a tabela aqui faz a
-- consulta inteira falhar com "relation does not exist" justamente no caso que
-- ela existe para detectar. O runner informa a contagem quando roda.
select
  case
    when to_regclass('public.schema_migrations') is null
      then 'schema_migrations NAO existe — instalação manual, --baseline é o caminho'
    else 'schema_migrations JA existe — NAO use --baseline; rode o runner sem flags'
  end as tabela_de_controle;
