#!/usr/bin/env bash
# Instalação de primeira vez do NEXOR CRM em servidor próprio.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3010}"
UNIT_DIR="$HOME/.config/systemd/user"
# Mesma resolução de scripts/update.sh:135 e scripts/run-wacrm-prod.py:15 —
# NEXOR_ENV, quando definida, é o arquivo que o processo real (run-wacrm-
# prod.py) de fato carrega. Sem isso, instalações que usam NEXOR_ENV para
# apontar o .env para outro caminho teriam install.sh lendo/criando um
# arquivo diferente do que os serviços systemd realmente usam.
ENV_FILE="${NEXOR_ENV:-$INSTALL_DIR/.env}"

echo "==> NEXOR CRM — instalação"
echo "    Diretório: $INSTALL_DIR"
echo "    Porta:     $PORT"

# 1. Node
if ! command -v node >/dev/null 2>&1; then
  echo "ERRO: Node.js não encontrado. Instale Node 20 ou superior." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERRO: Node $NODE_MAJOR encontrado. É necessário Node 20 ou superior." >&2
  exit 1
fi
NODE_BIN_DIR="$(dirname "$(command -v node)")"
echo "==> Node $(node -v) em $NODE_BIN_DIR"

# 2. python3, exigido pelos wrappers de serviço
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERRO: python3 não encontrado. Ele é necessário para os serviços." >&2
  exit 1
fi

# 3. Arquivo de ambiente
if [ ! -f "$ENV_FILE" ]; then
  cp "$INSTALL_DIR/.env.local.example" "$ENV_FILE"
  echo "==> $ENV_FILE criado a partir do exemplo."
  echo "    PREENCHA $ENV_FILE antes de subir os serviços."
  NEEDS_ENV=1
else
  echo "==> $ENV_FILE já existe, mantido."
  NEEDS_ENV=0
fi

# 4. Dependências
echo "==> Instalando dependências..."
cd "$INSTALL_DIR"
npm ci

# 4b. Migrations — depois do "npm ci" (garante as dependências do runner, ex.
# o driver `pg`) e antes do "npm run build", para o schema já estar em dia
# quando os serviços subirem pela primeira vez.
#
# Duplica read_env_var() de scripts/update.sh (que por sua vez replica
# parse_env_line() de scripts/run-wacrm-prod.py — ver comentário lá para o
# algoritmo linha a linha e por que não é `source .env`). Não foi extraída
# para um lib/ compartilhado: install.sh e update.sh são scripts standalone,
# cada um baixado/copiado e executado isoladamente (não há hoje nenhuma
# infraestrutura de source entre scripts neste repo), então introduzir um
# terceiro arquivo só para ~30 linhas estáveis trocaria uma duplicação
# pequena e óbvia por acoplamento de path entre scripts que precisam
# continuar funcionando cada um sozinho.
read_env_var() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  local line stripped k v result=""
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    stripped="$(printf '%s' "$line" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    [ -n "$stripped" ] || continue
    case "$stripped" in
      \#*) continue ;;
    esac
    case "$stripped" in
      *=*) ;;
      *) continue ;;
    esac
    k="${stripped%%=*}"
    v="${stripped#*=}"
    k="$(printf '%s' "$k" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    [ -n "$k" ] || continue
    [ "$k" = "$key" ] || continue
    v="$(printf '%s' "$v" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    result="$v"
  done < "$file"
  if [ -n "$result" ]; then
    if [[ ( "$result" == \"*\" && "$result" == *\" ) || ( "$result" == \'*\' && "$result" == *\' ) ]]; then
      result="${result:1:-1}"
    fi
    printf '%s' "$result"
  fi
}

# Mesma precedência de scripts/update.sh: variável já presente no ambiente do
# shell (override deliberado do operador) vence; ENV_FILE é só o fallback. As
# duas pontas precisam concordar, senão o mesmo .env, no mesmo host,
# resolveria para valores (e para o MESMO ARQUIVO, via NEXOR_ENV) diferentes
# dependendo de qual script rodou.
if [ -z "${SUPABASE_DB_URL:-}" ]; then
  SUPABASE_DB_URL_FROM_FILE="$(read_env_var "SUPABASE_DB_URL" "$ENV_FILE")"
  if [ -n "$SUPABASE_DB_URL_FROM_FILE" ]; then
    export SUPABASE_DB_URL="$SUPABASE_DB_URL_FROM_FILE"
    echo "==> SUPABASE_DB_URL carregada de $ENV_FILE"
  fi
fi

# .env.local.example vem com um valor de exemplo NÃO VAZIO em SUPABASE_DB_URL
# (postgres://postgres:your-db-password@your-project.supabase.co:...) — de
# propósito, para o operador ver o formato esperado. Isso significa que
# "definida" sozinho não basta: um .env recém-copiado tem a variável presente,
# só que com o placeholder. Sem esta checagem, o guard abaixo passaria e o
# runner tentaria conectar literalmente em "your-project.supabase.co".
case "${SUPABASE_DB_URL:-}" in
  *your-db-password*|*your-project.supabase.co*)
    echo "AVISO: SUPABASE_DB_URL em $ENV_FILE ainda está com o valor de exemplo"
    echo "       do .env.local.example (your-db-password / your-project.supabase.co)."
    echo "       Substitua pela connection string real (Supabase → Project"
    echo "       Settings → Database → Connection string). Tratando como não"
    echo "       definida por enquanto."
    unset SUPABASE_DB_URL
    ;;
esac

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  # AVISO, não ERRO: install.sh precisa continuar re-executável sem essa
  # variável — é o caminho normal na execução que acabou de criar $ENV_FILE
  # (só tem placeholder ainda) e também o de uma instalação pré-existente que
  # nunca preencheu a variável (ela é nova; PORT=3020 bash scripts/install.sh
  # para trocar de porta, por exemplo, precisa continuar funcionando sem
  # exigir SUPABASE_DB_URL). Abortar aqui deixaria o "npm ci" de cima feito
  # mas nem o build nem as units systemd atualizados — pior que só avisar e
  # seguir.
  echo "AVISO: SUPABASE_DB_URL não definida (nem no ambiente, nem em $ENV_FILE)"
  echo "       — migrations puladas nesta execução. Preencha essa variável em"
  echo "       $ENV_FILE e rode scripts/install.sh de novo (ou"
  echo "       'node scripts/migrate.mjs' manualmente) antes de considerar a"
  echo "       instalação pronta para uso."
  echo "       ATENÇÃO — instalações com schema já aplicado à mão (sem tabela"
  echo "       public.schema_migrations): NÃO defina SUPABASE_DB_URL em .env"
  echo "       ainda. Faça backup do banco e rode primeiro, manualmente:"
  echo "         SUPABASE_DB_URL=... node scripts/migrate.mjs --baseline NNN"
  echo "       Só depois do baseline concluído é seguro salvar SUPABASE_DB_URL"
  echo "       em .env e prosseguir. Ver README.md, seção \"Banco de dados e"
  echo "       migrações\"."
else
  echo "==> Aplicando migrations pendentes..."
  node scripts/migrate.mjs || {
    echo "ERRO: falha ao aplicar migrations. O CÓDIGO E O ESTADO DO BANCO PODEM TER" >&2
    echo "      DIVERGIDO: dependendo de qual migration falhou, parte delas já" >&2
    echo "      pode ter sido aplicada e fica registrada em public.schema_migrations," >&2
    echo "      mesmo com o restante da instalação (build, serviços) ainda não" >&2
    echo "      concluído. Corrija a causa do erro acima e rode" >&2
    echo "      'SUPABASE_DB_URL=... node scripts/migrate.mjs' de novo (ou" >&2
    echo "      scripts/install.sh de novo) antes de iniciar os serviços." >&2
    exit 1
  }
  echo "==> Migrations em dia."
fi

echo "==> Construindo..."
npm run build

# 5. Units systemd
mkdir -p "$UNIT_DIR"
for unit in wacrm wacrm-worker; do
  sed -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
      -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" \
      -e "s|__PORT__|$PORT|g" \
      "$INSTALL_DIR/deploy/$unit.service.template" > "$UNIT_DIR/$unit.service"
  echo "==> Unit instalada: $UNIT_DIR/$unit.service"
done

# 6. Sobreviver a logout e reboot
loginctl enable-linger "$USER" 2>/dev/null || \
  echo "AVISO: não foi possível habilitar linger; os serviços podem parar ao sair da sessão."

systemctl --user daemon-reload

if [ "$NEEDS_ENV" -eq 1 ]; then
  echo ""
  echo "==> Instalação concluída, serviços NÃO iniciados."
  echo "    1. Preencha $ENV_FILE (inclusive SUPABASE_DB_URL)"
  echo "    2. Rode: bash scripts/install.sh          (aplica as migrations)"
  echo "    3. Rode: systemctl --user enable --now wacrm.service wacrm-worker.service"
  exit 0
fi

systemctl --user enable --now wacrm.service wacrm-worker.service
echo ""
echo "==> Pronto. NEXOR CRM rodando em http://127.0.0.1:$PORT"
echo "    Status: systemctl --user status wacrm.service"
