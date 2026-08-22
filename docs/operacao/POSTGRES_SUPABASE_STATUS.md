# Estado de Postgres/Supabase — CRM pausado

## Resultado da auditoria — 2026-08-10

- O CRM possui o código e as migrations Supabase em `./supabase/`.
- Não foi localizado banco Postgres local dentro do projeto.
- Não foi localizado o backup citado anteriormente em `/home/hermes/BACKUPS_CRM/`; esse caminho não existe na VPS.
- Não foi executada conexão, migration, alteração ou exclusão no Supabase externo.
- O CRM permanece pausado e as units `wacrm.service`/`wacrm-worker.service` permanecem inativas.

## Estado

**BACKUP NÃO CERTIFICADO.** O banco externo é dependência preservada fora do código pausado, mas não há evidência local de backup restaurável neste momento.

## Gate para reativação

Antes de reativar o CRM, Anderson precisa decidir e autorizar:

1. fonte atual do banco Postgres/Supabase;
2. backup completo e data de criação;
3. teste de restauração ou evidência equivalente;
4. retenção do banco e das credenciais;
5. compatibilidade das migrations do código pausado.

Nenhum segredo ou connection string é registrado nesta nota.
