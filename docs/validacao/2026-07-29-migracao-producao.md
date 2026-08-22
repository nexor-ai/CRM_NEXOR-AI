# Migração da produção 043 → 050 — 2026-07-29

Primeira execução real do runner contra o banco de produção da NEXOR AI.

## Sequência executada

1. **Backup** — o relatório histórico registrava um `pg_dump` 17.6 via container, com 1.1 MB e 81 tabelas. O arquivo não foi localizado em 2026-08-10; ver `docs/operacao/POSTGRES_SUPABASE_STATUS.md`. Nenhum novo dump foi executado nesta reorganização.

2. **Confirmação do NNN** — `scripts/migration-check/detectar-baseline.sql`
   apontou `040`–`043` APLICADA e `044`–`050` faltando. Corte limpo, sem
   APLICADA depois de faltando. O número **não** foi assumido: o único dump
   disponível chamava-se `pre-043`, o que tornava "043" um palpite até a
   verificação.

3. **`--baseline 043`** — 43 registradas sem executar SQL.

4. **Aplicação de `044`–`050`** — executada pelo Anderson (a camada de
   permissão do Claude Code barra DDL em produção).

## Verificação pós-migração

- `--dry-run`: "Nada pendente — o banco já está atualizado."
- `public.schema_migrations`: 50 registros.
- Detector: as 11 migrations de `040` a `050` marcadas APLICADA **por objeto
  real** (tabela, coluna, função, policy) — não apenas pelo registro de
  controle. As duas fontes concordam.
- `wacrm.service` e `wacrm-worker.service` ativos; `/api/version` HTTP 200.
- Zero erros nos logs. Nota: um `grep -i error` no worker retorna dezenas de
  falsos positivos — são linhas de SUCESSO contendo `"errors":[]` e
  `"failed":0`. Filtrar por `traceback|exception|does not exist` em vez disso.

## Riscos que não se materializaram

As 7 migrations foram lidas antes de aplicar: os únicos `DELETE` estavam
**dentro de corpos de função** (trigger de departamentos, expurgo de
transcrições) — definições, não execuções. Os `DROP POLICY` são todos seguidos
de recriação. O `DROP CONSTRAINT` da 047 remove o limite de uma instância de
WhatsApp por conta, que é o objetivo declarado da migration.

## Estado final

Produção em schema 050, tabela de controle preenchida, `origin/main` em dia.
A partir daqui `scripts/update.sh` aplica migrations sozinho — este foi o
único baseline manual que esta instalação precisará.
