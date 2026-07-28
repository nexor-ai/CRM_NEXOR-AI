# Verificação das migrations 044–050

Valida as migrations contra uma **réplica da produção**, não contra um banco
vazio: sobe a imagem oficial do Supabase (PostgreSQL 17, igual à produção),
restaura o dump de `backups/` no schema 043 e aplica 044→050 na ordem.

Responde três perguntas que ler o SQL não responde:

1. **Aplicam?** Numa instalação que está no 043, como a produção está hoje.
2. **São idempotentes?** O `lock_timeout` de 045/048/049 existe para a migration
   falhar rápido sob lock concorrente, com a promessa de "basta repetir depois".
   Se repetir quebrasse, a promessa seria falsa. A 045 de fato quebrava — lhe
   faltava `IF NOT EXISTS` — e por isso a verificação existe.
3. **O isolamento multi-tenant é real?** `tenant-isolation-proof.sql` tenta
   quatro referências cruzando contas e exige que o banco recuse as quatro,
   além de um controle positivo que precisa ser aceito (sem ele, um banco que
   recusasse tudo passaria no teste).

## Rodar

    bash scripts/migration-check/run.sh

Requer Docker. Não toca em banco de produção: o container é descartável, sem
porta publicada, e é removido ao final.
