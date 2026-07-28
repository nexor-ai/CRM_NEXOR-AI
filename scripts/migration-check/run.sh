#!/usr/bin/env bash
# Aplica 044-050 sobre uma réplica da produção e prova o isolamento multi-tenant.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

CONTAINER=nexor-mig-check
IMAGE=public.ecr.aws/supabase/postgres:17.6.1.141
DUMP="$(ls -1 backups/supabase-pre-043-*.sql | sort | tail -n1)"
DOCKER=${DOCKER:-docker}

[ -s "$DUMP" ] || { echo "ERRO: dump do schema 043 não encontrado em backups/" >&2; exit 1; }
echo "==> dump: $DUMP"

cleanup() { $DOCKER rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

cleanup
$DOCKER run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=test "$IMAGE" >/dev/null
# A imagem inicializa o cluster num servidor temporário, DERRUBA o Postgres e
# sobe o definitivo. Um pg_isready isolado acerta a janela do temporário e a
# restauração morre no meio ("database system is shutting down"). Por isso
# exigimos estabilidade: várias verificações consecutivas, já com o marcador de
# fim de inicialização no log.
echo "==> aguardando o Postgres estabilizar"
# Nota: nada de `[ cond ] && break` aqui. Sob `set -e`, quando o teste falha a
# lista-E devolve 1 como último comando do bloco e o script morre no meio da
# espera. Usar `if` explícito é o que mantém o laço vivo até estabilizar.
pronto=0
for _ in $(seq 1 120); do
  if $DOCKER exec "$CONTAINER" psql -U postgres -tAc "select 1" >/dev/null 2>&1; then
    pronto=$((pronto + 1))
  else
    pronto=0
  fi
  if [ "$pronto" -ge 5 ]; then
    break
  fi
  sleep 1
done
if [ "$pronto" -lt 5 ]; then
  echo "ERRO: Postgres não estabilizou a tempo." >&2
  exit 1
fi

# supabase_vault e pg_stat_statements são geridos pela plataforma, não pelo dump.
grep -vE 'CREATE EXTENSION IF NOT EXISTS "(supabase_vault|pg_stat_statements)"' "$DUMP" > /tmp/dump043.sql
$DOCKER cp /tmp/dump043.sql "$CONTAINER":/tmp/dump043.sql >/dev/null
$DOCKER cp scripts/migration-check/storage-stub.sql "$CONTAINER":/tmp/storage-stub.sql >/dev/null
$DOCKER cp scripts/migration-check/tenant-isolation-proof.sql "$CONTAINER":/tmp/tenant-proof.sql >/dev/null

# -d postgres é obrigatório: sem ele o psql tenta abrir um banco com o nome do
# papel, e supabase_admin não tem banco homônimo.
psql_run() { $DOCKER exec "$CONTAINER" psql -U "${2:-postgres}" -d postgres -v ON_ERROR_STOP=1 -q -f "$1" 2>&1; }

echo "==> restaurando schema 043"
$DOCKER exec "$CONTAINER" psql -U postgres -q \
  -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;" >/dev/null
$DOCKER exec "$CONTAINER" psql -U postgres -q \
  -c "DROP PUBLICATION IF EXISTS supabase_realtime; CREATE PUBLICATION supabase_realtime;" >/dev/null 2>&1 || true
psql_run /tmp/dump043.sql | grep -E "^psql.*ERROR" && { echo "ERRO ao restaurar o dump" >&2; exit 1; } || true
# storage é do serviço de Storage; o schema pertence a supabase_admin.
psql_run /tmp/storage-stub.sql supabase_admin | grep -E "^psql.*ERROR" && exit 1 || true

migrations() { ls -1 supabase/migrations/04[4-9]*.sql supabase/migrations/050*.sql | sort; }

aplicar() {
  local rotulo="$1" falhou=0
  echo "==> $rotulo"
  for f in $(migrations); do
    b="$(basename "$f")"
    $DOCKER cp "$f" "$CONTAINER":/tmp/"$b" >/dev/null
    saida="$($DOCKER exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q -f /tmp/"$b" 2>&1 \
      | grep -viE '^\s*$|NOTICE|WARNING' || true)"
    if [ -z "$saida" ]; then printf '    OK    %s\n' "$b"
    else falhou=1; printf '    FALHA %s\n' "$b"; echo "$saida" | head -5 | sed 's/^/            /'; fi
  done
  return $falhou
}

aplicar "passada 1 — instalação limpa"
aplicar "passada 2 — reaplicação (idempotência)"

echo "==> prova de isolamento multi-tenant"
$DOCKER exec "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q -f /tmp/tenant-proof.sql 2>&1 \
  | grep -iE "BLOQUEADO|VAZAMENTO|CONTROLE" | sed 's/^.*NOTICE:  /    /;s/^psql.*://'

echo
echo "==> VERIFICAÇÃO CONCLUÍDA COM SUCESSO"
