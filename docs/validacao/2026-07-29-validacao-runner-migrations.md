# Validação contra Postgres real — 2026-07-29 (commit c36f281)

O gap de cobertura que estava deferido foi FECHADO.

Docker estava disponível o tempo todo: o daemon roda há 17h; o que falhava era
permissão do usuário (precisa de `sudo`). A imagem oficial do Supabase PG17 já
estava local. O relato anterior de "Docker indisponível" estava errado.

## Resultado: 16 checagens, TODAS VERDES

`scripts/migration-check/validate-runner.sh`, contra a imagem oficial do
Supabase (PG17, igual à produção), com TLS real e CA própria — o que prova de
quebra o `SUPABASE_DB_CA_PATH`.

| Cenário | O que prova | Resultado |
|---|---|---|
| A | Instalação limpa: 001..050 num banco zerado | 50 registradas, 56 tabelas |
| D | Idempotência: rodar de novo não faz nada | "nada pendente" |
| B1 | VPS em 043 sem tabela de controle: runner RECUSA | recusou, nada aplicado |
| B2 | `--baseline 043` registra sem rodar SQL | 43 registradas |
| B3 | Runner aplica só 044..050 | 50 registradas |
| C1 | Migration editada após publicada trava | travou por checksum |
| C2 | `--force-checksum` destrava | destravou |
| C3 | Recusa marcar como aplicada uma que nunca rodou | recusou |
| E | `sslmode=disable` na connection string | rejeitado |

## Bug real encontrado pela validação

`storage-stub.sql` só tinha o mínimo para a migration 044. Faltavam
`file_size_limit` e `allowed_mime_types`, usadas pela 008.

Consequência: **instalação limpa nunca tinha funcionado nem sido testada.** O
harness antigo só aplicava 044..050 sobre um dump do 043, então o caminho que
todo cliente novo percorre — 001 em diante — nunca havia sido exercitado.
Corrigido: o stub agora espelha o schema real do Supabase Storage.

## Como repetir

```
DOCKER="sudo docker" bash scripts/migration-check/validate-runner.sh
```

## Pendente: PUSH — bloqueado pelo harness

`git push` foi negado pelo classificador de auto-mode desta sessão. Não é
questão de credencial: o `gh auth status` está logado como `nexor-ai`.

`origin/main` continua em `8602b1a`. 31 commits locais à espera.
