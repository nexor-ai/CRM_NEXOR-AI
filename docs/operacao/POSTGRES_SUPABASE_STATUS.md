# Estado de Postgres/Supabase — CRM NEXOR

## Certificação operacional — 2026-08-23 BRT

**Status: backup e migrations certificados para o runtime canônico** `/home/hermes/ESCRITORIO_NEXOR-AI/tools/crm-nexor/`.

## Evidências

- Dump completo criado em `/home/hermes/ESCRITORIO_NEXOR-AI/operacional/backups/crm-nexor-db-20260823/crm-nexor-20260823.dump`.
  - Formato PostgreSQL custom; permissão `600`; diretório `700`.
  - SHA-256: `9c97daeeb092abd41bb23e51fcbf1cb24a19400c9085de5ad44b7e98640a6a98`.
  - `pg_restore --list` com cliente PostgreSQL 17 listou 1.195 objetos, incluindo `contacts` e `schema_migrations`.
- A validação de restauração integral em PostgreSQL genérico foi interrompida porque o dump usa a extensão proprietária Supabase `supabase_vault`, indisponível na imagem oficial PostgreSQL 17. Isso não indica arquivo corrompido; a restauração integral deve ser testada em ambiente Supabase compatível antes de declarar recuperação de desastre integral.
- A CA `Supabase Root 2021 CA` foi restaurada no runtime canônico como `prod-ca-2021.crt`, com permissão `600`. O `.env` agora aponta para o caminho real em `tools/crm-nexor`; cópia prévia protegida em `operacional/backups/crm-nexor-ca-path-20260823/.env.before`.
- `scripts/migrate.mjs --dry-run` identificou 051 e 052; pré-checagem de identidade Evolution retornou zero colisões; ambas foram aplicadas com sucesso.
- Pós-aplicação: `public.schema_migrations` contém 52 registros, a última é `052_global_evolution_remote_identity.sql`, e o índice `whatsapp_config_global_evolution_identity_key` existe.
- Repetição do `--dry-run`: **Nada pendente — o banco já está atualizado.**

## Segurança operacional

- Não registrar connection strings, chaves ou dados do dump em notas, logs ou Git.
- Migrations publicadas são imutáveis: qualquer correção deve entrar em migration nova.
- Antes de mudança futura de schema: gerar dump novo, executar `--dry-run`, verificar impacto e aplicar somente com autorização de Anderson.
- A CA e o dump atual resolvem o bloqueio de backup/migration, mas não substituem uma política de retenção offsite nem teste de restauração em Supabase compatível.
