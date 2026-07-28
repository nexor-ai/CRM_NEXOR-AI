#!/usr/bin/env bash
# Instalação de primeira vez do NEXOR CRM em servidor próprio.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3010}"
UNIT_DIR="$HOME/.config/systemd/user"

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
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env.local.example" "$INSTALL_DIR/.env"
  echo "==> .env criado a partir do exemplo."
  echo "    PREENCHA $INSTALL_DIR/.env antes de subir os serviços."
  NEEDS_ENV=1
else
  echo "==> .env já existe, mantido."
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

if [ "$NEEDS_ENV" -eq 1 ]; then
  # .env acabado de ser criado a partir do exemplo — só tem placeholder, não
  # existe SUPABASE_DB_URL de verdade para conectar ainda. Rodar o runner
  # aqui produziria só um erro de connection string inválida. Instalação
  # segue (build, units) e para no fim como já fazia; a próxima execução de
  # install.sh, depois do .env preenchido, cai no ramo abaixo e aplica tudo.
  echo "==> .env recém-criado — migrations puladas nesta execução."
  echo "    Rode scripts/install.sh de novo depois de preencher $INSTALL_DIR/.env"
  echo "    para aplicá-las."
else
  # Mesma precedência de scripts/update.sh: variável já presente no ambiente
  # do shell (override deliberado do operador) vence; .env é só o fallback.
  # As duas pontas precisam concordar, senão o mesmo .env, no mesmo host,
  # resolveria para valores diferentes dependendo de qual script rodou.
  if [ -z "${SUPABASE_DB_URL:-}" ]; then
    SUPABASE_DB_URL_FROM_FILE="$(read_env_var "SUPABASE_DB_URL" "$INSTALL_DIR/.env")"
    if [ -n "$SUPABASE_DB_URL_FROM_FILE" ]; then
      export SUPABASE_DB_URL="$SUPABASE_DB_URL_FROM_FILE"
      echo "==> SUPABASE_DB_URL carregada de $INSTALL_DIR/.env"
    fi
  fi
  if [ -z "${SUPABASE_DB_URL:-}" ]; then
    echo "ERRO: SUPABASE_DB_URL não definida (nem no ambiente, nem em" >&2
    echo "      $INSTALL_DIR/.env)." >&2
    echo "      Obtenha a connection string em Supabase → Project Settings →" >&2
    echo "      Database → Connection string (a direta do Postgres, não as" >&2
    echo "      chaves NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) e" >&2
    echo "      defina SUPABASE_DB_URL em $INSTALL_DIR/.env antes de instalar." >&2
    echo "      ATENÇÃO — instalações com schema já aplicado à mão (sem tabela" >&2
    echo "      public.schema_migrations): NÃO defina SUPABASE_DB_URL em .env" >&2
    echo "      ainda. Faça backup do banco e rode primeiro, manualmente:" >&2
    echo "        SUPABASE_DB_URL=... node scripts/migrate.mjs --baseline NNN" >&2
    echo "      Só depois do baseline concluído é seguro salvar SUPABASE_DB_URL" >&2
    echo "      em .env e prosseguir. Ver README.md, seção \"Banco de dados e" >&2
    echo "      migrações\"." >&2
    exit 1
  fi
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
  echo "    1. Preencha $INSTALL_DIR/.env (inclusive SUPABASE_DB_URL)"
  echo "    2. Rode: bash scripts/install.sh          (aplica as migrations)"
  echo "    3. Rode: systemctl --user enable --now wacrm.service wacrm-worker.service"
  exit 0
fi

systemctl --user enable --now wacrm.service wacrm-worker.service
echo ""
echo "==> Pronto. NEXOR CRM rodando em http://127.0.0.1:$PORT"
echo "    Status: systemctl --user status wacrm.service"
