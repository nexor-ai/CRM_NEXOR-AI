#!/usr/bin/env bash
# Validação real do runner de migrations contra Postgres de verdade.
# Usa a imagem oficial do Supabase (PG17, igual à produção) num container
# descartável. NÃO toca no banco de produção nem em arquivo do repositório.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d -t nexor-migrate-XXXXXX)"
CERTS="$WORK/certs"
CONTAINER=nexor-migrate-validate
PORT=55432
IMG=public.ecr.aws/supabase/postgres:17.6.1.141
D="${DOCKER:-docker}"

falhas=0
ok()   { echo "  ✅ $1"; }
falha(){ echo "  ❌ $1"; falhas=$((falhas+1)); }

# Duas responsabilidades separadas de propósito: rm_container também é chamado
# ANTES de subir o container (para matar sobra de execução anterior), e nesse
# momento o $WORK já contém os certificados recém-gerados — apagá-lo ali
# destruiria o que a etapa 1 acabou de produzir.
rm_container() { $D rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
cleanup() { rm_container; rm -rf "$WORK"; }
trap cleanup EXIT

echo "==> 1. Certificados (o runner exige TLS verificado; Supabase usa CA própria)"
rm -rf "$CERTS"; mkdir -p "$CERTS"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -keyout "$CERTS/ca.key" -out "$CERTS/ca.crt" \
  -subj "/CN=nexor-test-ca" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -keyout "$CERTS/server.key" -out "$CERTS/server.csr" \
  -subj "/CN=localhost" >/dev/null 2>&1
openssl x509 -req -in "$CERTS/server.csr" -days 2 \
  -CA "$CERTS/ca.crt" -CAkey "$CERTS/ca.key" -CAcreateserial \
  -extfile <(printf "subjectAltName=DNS:localhost,IP:127.0.0.1") \
  -out "$CERTS/server.crt" >/dev/null 2>&1
chmod 644 "$CERTS/server.key" "$CERTS/server.crt"
[ -s "$CERTS/server.crt" ] && ok "CA e certificado de servidor gerados" || { falha "openssl"; exit 1; }

echo "==> 2. Subindo Postgres 17 (imagem oficial Supabase)"
rm_container
$D run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1:$PORT:5432 \
  "$IMG" >/dev/null 2>&1 || { falha "docker run"; exit 1; }

# A imagem do Supabase sobe um servidor TEMPORÁRIO para rodar o init, e só
# depois reinicia com o definitivo. Um psql que responde durante o init não
# significa "pronto": qualquer ALTER SYSTEM feito nessa janela é perdido no
# restart. Esperar a marca de fim do init antes de considerar pronto.
for i in $(seq 1 90); do
  $D logs "$CONTAINER" 2>&1 | grep -q "PostgreSQL init process complete" && break
  sleep 2
done
for i in $(seq 1 60); do
  $D exec "$CONTAINER" psql -U postgres -tAc "select 1" >/dev/null 2>&1 && break
  sleep 2
done
$D exec "$CONTAINER" psql -U postgres -tAc "select 1" >/dev/null 2>&1 \
  && ok "Postgres pronto na porta $PORT" || { falha "Postgres não subiu"; $D logs "$CONTAINER" 2>&1 | tail -20; exit 1; }

echo "==> 3. Habilitando TLS (chave copiada para dentro, dona = usuário do banco)"
$D cp "$CERTS/server.crt" "$CONTAINER":/var/lib/postgresql/nexor.crt >/dev/null 2>&1
$D cp "$CERTS/server.key" "$CONTAINER":/var/lib/postgresql/nexor.key >/dev/null 2>&1
PGUSER_IN="$($D exec "$CONTAINER" stat -c '%U' /var/lib/postgresql/data 2>/dev/null | tr -d '[:space:]')"
$D exec -u 0 "$CONTAINER" chown "${PGUSER_IN:-postgres}" /var/lib/postgresql/nexor.key /var/lib/postgresql/nexor.crt >/dev/null 2>&1
$D exec -u 0 "$CONTAINER" chmod 600 /var/lib/postgresql/nexor.key >/dev/null 2>&1
# supabase_admin é o único superusuário na imagem; `postgres` não pode ALTER
# SYSTEM. E cada ALTER SYSTEM precisa de um -c próprio: vários num só -c viram
# transação implícita, e ALTER SYSTEM não roda dentro de transação.
SSL_ON=""
for tentativa in 1 2 3 4 5; do
  # Ordem importa: cert e key ANTES de ssl='on'. Na ordem inversa, um erro no
  # meio deixa o servidor com TLS ligado e sem certificado, e ele morre no
  # próximo restart com `could not load server certificate file ""`.
  for par in "ssl_cert_file='/var/lib/postgresql/nexor.crt'" \
             "ssl_key_file='/var/lib/postgresql/nexor.key'" \
             "ssl='on'"; do
    erro="$($D exec "$CONTAINER" psql -U supabase_admin -d postgres -q -c "alter system set $par" 2>&1)"
    [ -n "$erro" ] && echo "     (tentativa $tentativa, $par: $erro)"
  done
  $D exec "$CONTAINER" psql -U supabase_admin -d postgres -tAc "select pg_reload_conf()" >/dev/null 2>&1
  sleep 3
  SSL_ON="$($D exec "$CONTAINER" psql -U postgres -tAc "show ssl" 2>/dev/null | tr -d '[:space:]')"
  [ "$SSL_ON" = "on" ] && break
done
[ "$SSL_ON" = "on" ] && ok "TLS ativo no servidor" || { falha "TLS não ativou (show ssl='$SSL_ON')"; $D logs "$CONTAINER" 2>&1 | tail -10; exit 1; }

export SUPABASE_DB_URL="postgres://postgres:postgres@localhost:$PORT/postgres"
export SUPABASE_DB_CA_PATH="$CERTS/ca.crt"

psql_c() { $D exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
# supabase_admin é o único superusuário: `postgres` não consegue dropar o schema
# public nem criar o schema storage. Rodar o reset como postgres falhava em
# silêncio e cada cenário herdava a sujeira do anterior.
psql_admin() { $D exec -i "$CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
reset_db() {
  psql_admin -c "drop schema if exists public cascade; create schema public;
             grant usage, create on schema public to postgres, anon, authenticated, service_role;
             drop schema if exists storage cascade;
             drop publication if exists supabase_realtime; create publication supabase_realtime;" >/dev/null 2>&1
  psql_admin < "$REPO/scripts/migration-check/storage-stub.sql" >/dev/null 2>&1
  # Sem isto, um reset que falhou em silêncio faz o cenário seguinte validar
  # o estado do cenário anterior e reportar sucesso ou fracasso falso.
  local sobrou
  sobrou="$(psql_c -tAc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')" 2>/dev/null | tr -d '[:space:]')"
  [ "${sobrou:-x}" = "0" ] || { falha "reset_db não zerou o schema public (sobraram '$sobrou' tabelas)"; return 1; }
  local temstorage
  temstorage="$(psql_c -tAc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='storage' and c.relname='buckets'" 2>/dev/null | tr -d '[:space:]')"
  [ "${temstorage:-0}" = "1" ] || { falha "stub de storage não aplicou"; return 1; }
  return 0
}
runner() { (cd "$REPO" && node scripts/migrate.mjs "$@" 2>&1); }

echo ""
echo "==> CENÁRIO A — instalação limpa: runner aplica 001..050 num banco zerado"
reset_db
outA="$(runner)"; rcA=$?
if [ $rcA -eq 0 ]; then ok "runner saiu 0"; else falha "runner saiu $rcA"; echo "$outA" | tail -15; fi
nA="$(psql_c -tAc "select count(*) from public.schema_migrations" 2>/dev/null | tr -d '[:space:]')"
[ "$nA" = "50" ] && ok "50 migrations registradas" || falha "esperava 50 registradas, veio '$nA'"
tA="$(psql_c -tAc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')" 2>/dev/null | tr -d '[:space:]')"
[ "${tA:-0}" -gt 20 ] && ok "$tA tabelas criadas em public" || falha "poucas tabelas: '$tA'"

echo ""
echo "==> CENÁRIO D — idempotência: rodar de novo não faz nada"
outD="$(runner)"; rcD=$?
[ $rcD -eq 0 ] && ok "runner saiu 0" || falha "runner saiu $rcD"
echo "$outD" | grep -qi "nada pendente\|em dia\|nenhuma" && ok "reportou nada pendente" || { falha "não reportou 'nada pendente'"; echo "$outD" | tail -5; }

echo ""
echo "==> CENÁRIO B — o caso da VPS: schema 043 aplicado à mão, sem tabela de controle"
reset_db
DUMP="$(ls -1S "$REPO"/backups/supabase-pre-043-*.sql | head -1)"
grep -vE 'CREATE EXTENSION IF NOT EXISTS "(supabase_vault|pg_stat_statements)"' "$DUMP" > "$WORK/dump043.sql"
psql_admin < "$WORK/dump043.sql" >/dev/null 2>&1
psql_admin < "$REPO/scripts/migration-check/storage-stub.sql" >/dev/null 2>&1
hasC="$(psql_c -tAc "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='contacts'" 2>/dev/null | tr -d '[:space:]')"
[ "$hasC" = "1" ] && ok "dump 043 restaurado (tabela contacts existe)" || falha "dump não restaurou (contacts='$hasC')"

echo "  -- B1: runner SEM baseline deve RECUSAR (guard antidestruição)"
outB1="$(runner)"; rcB1=$?
if [ $rcB1 -ne 0 ] && echo "$outB1" | grep -qi "baseline"; then
  ok "recusou e mandou usar --baseline (saída $rcB1)"
else
  falha "NÃO recusou! saída=$rcB1 — isto apagaria dados reais"; echo "$outB1" | tail -20
fi
nB1="$(psql_c -tAc "select count(*) from public.schema_migrations" 2>/dev/null | tr -d '[:space:]')"
[ "${nB1:-0}" = "0" ] && ok "nada foi registrado nem aplicado" || falha "registrou $nB1 linhas quando devia recusar"

echo "  -- B2: --baseline 043 marca 001..043 sem rodar SQL"
outB2="$(runner --baseline 043)"; rcB2=$?
[ $rcB2 -eq 0 ] && ok "baseline saiu 0" || { falha "baseline saiu $rcB2"; echo "$outB2" | tail -10; }
nB2="$(psql_c -tAc "select count(*) from public.schema_migrations" 2>/dev/null | tr -d '[:space:]')"
[ "$nB2" = "43" ] && ok "43 registradas" || falha "esperava 43, veio '$nB2'"

echo "  -- B3: runner aplica só 044..050"
outB3="$(runner)"; rcB3=$?
[ $rcB3 -eq 0 ] && ok "runner saiu 0" || { falha "runner saiu $rcB3"; echo "$outB3" | tail -25; }
nB3="$(psql_c -tAc "select count(*) from public.schema_migrations" 2>/dev/null | tr -d '[:space:]')"
[ "$nB3" = "50" ] && ok "50 registradas (044..050 aplicadas)" || falha "esperava 50, veio '$nB3'"

echo ""
echo "==> CENÁRIO C — migration editada depois de publicada (divergência de checksum)"
psql_c -c "update public.schema_migrations set checksum='0000000000000000000000000000000000000000000000000000000000000000' where filename='047_multi_instance_cutover.sql'" >/dev/null 2>&1 \
  || psql_c -c "update public.schema_migrations set checksum='00' where filename=(select filename from public.schema_migrations order by filename limit 1 offset 46)" >/dev/null 2>&1
ALVO="$(psql_c -tAc "select filename from public.schema_migrations where checksum like '00%' limit 1" 2>/dev/null | tr -d '[:space:]')"
echo "  -- alvo: $ALVO"
outC1="$(runner)"; rcC1=$?
if [ $rcC1 -ne 0 ] && echo "$outC1" | grep -qi "checksum\|diverg"; then
  ok "runner travou por divergência (é o comportamento correto)"
else
  falha "não travou na divergência: saída=$rcC1"
fi
echo "  -- C2: --force-checksum destrava"
outC2="$(runner --force-checksum "$ALVO")"; rcC2=$?
[ $rcC2 -eq 0 ] && ok "--force-checksum saiu 0" || { falha "--force-checksum saiu $rcC2"; echo "$outC2" | tail -10; }
outC3="$(runner)"; rcC3=$?
[ $rcC3 -eq 0 ] && ok "runner voltou a funcionar" || falha "ainda travado: $rcC3"

echo "  -- C3: --force-checksum recusa arquivo nunca aplicado"
psql_c -c "delete from public.schema_migrations where filename='050_manual_assisted_channels.sql'" >/dev/null 2>&1
outC4="$(runner --force-checksum 050_manual_assisted_channels.sql)"; rcC4=$?
if [ $rcC4 -ne 0 ] && echo "$outC4" | grep -qi "não está registrad"; then
  ok "recusou marcar como aplicada uma migration que nunca rodou"
else
  falha "aceitou marcar migration não aplicada — buraco de integridade: $rcC4"
fi

echo ""
echo "==> CENÁRIO E — TLS: string com sslmode=disable não pode virar conexão em claro"
outE="$(SUPABASE_DB_URL="postgres://postgres:postgres@localhost:$PORT/postgres?sslmode=disable" runner --dry-run 2>&1)"; rcE=$?
if echo "$outE" | grep -qi "sslmode"; then
  ok "rejeitou sslmode=disable explicitamente"
elif [ $rcE -eq 0 ]; then
  falha "conectou mesmo com sslmode=disable"
else
  ok "não conectou com sslmode=disable (saída $rcE)"
fi

echo ""
echo "############################################"
if [ $falhas -eq 0 ]; then
  echo "# RESULTADO: TUDO PASSOU"
else
  echo "# RESULTADO: $falhas FALHA(S)"
fi
echo "############################################"
exit $falhas
