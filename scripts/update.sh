#!/usr/bin/env bash
# Atualiza o NEXOR CRM para o topo da branch de distribuição, com rollback
# automático. A branch — e não a última tag — é o que /api/updates compara para
# decidir se avisa o usuário; se este script seguisse a tag, quem atualizasse
# continuaria vendo o aviso.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$INSTALL_DIR"

LOG_DIR="$INSTALL_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/update-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "==> NEXOR CRM — atualização iniciada em $(date)"

# 0. Descobrir a porta da instalação real, para o healthcheck bater no lugar certo.
# Ordem de precedência:
#   1. Variável PORT definida explicitamente pelo cliente (override deliberado).
#   2. Porta configurada na unit systemd instalada (wacrm.service) — fonte de
#      verdade do que está de fato rodando.
#   3. Padrão 3010.
# A consulta ao systemd é só leitura e não pode abortar o script se a unit
# não existir (ex.: instalação rodando fora do systemd).
if [ -n "${PORT:-}" ]; then
  echo "==> Porta: $PORT (definida explicitamente pela variável de ambiente PORT)"
else
  UNIT_ENV="$(systemctl --user show wacrm.service -p Environment --value 2>/dev/null || true)"
  UNIT_PORT="$(printf '%s' "$UNIT_ENV" | tr ' ' '\n' | sed -n 's/^PORT=//p' | tail -n1)"
  if [ -n "$UNIT_PORT" ]; then
    PORT="$UNIT_PORT"
    echo "==> Porta: $PORT (detectada na unit systemd wacrm.service)"
  else
    PORT=3010
    echo "==> Porta: $PORT (padrão — não foi possível detectar a unit systemd wacrm.service)"
  fi
fi

# 1. Alterações locais do cliente
# O cliente não tem autorização para modificar o código: toda edição local
# deve ser sobrescrita para o padrão da distribuição voltar, não bloquear a
# atualização. Quem de fato faz a sobrescrita é o `git checkout --force` do
# passo 4 — aqui só avisamos e registramos o que vai ser perdido.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "==> AVISO: existem alterações locais não commitadas neste diretório." >&2
  echo "    Elas serão SOBRESCRITAS por esta atualização (o cliente não tem" >&2
  echo "    autorização para modificar o código instalado). Registro do que" >&2
  echo "    será perdido:" >&2
  git status --short >&2
fi

PREVIOUS_SHA="$(git rev-parse HEAD)"
echo "==> Versão atual: $PREVIOUS_SHA"

# 2. Buscar o topo da branch de distribuição
BRANCH="${NEXOR_UPDATE_BRANCH:-main}"
git fetch --prune --tags origin
TARGET_SHA="$(git rev-parse "origin/$BRANCH" 2>/dev/null || true)"
if [ -z "$TARGET_SHA" ]; then
  echo "ERRO: branch origin/$BRANCH não encontrada no repositório." >&2
  exit 1
fi
echo "==> Alvo: origin/$BRANCH ($TARGET_SHA)"

if [ "$TARGET_SHA" = "$PREVIOUS_SHA" ]; then
  echo "==> Já está na versão mais recente. Nada a fazer."
  exit 0
fi

echo "==> Commits a aplicar:"
git log --oneline "$PREVIOUS_SHA..$TARGET_SHA" | sed 's/^/    /'

# 3. Migrations que entram nesta atualização
NEW_MIGRATIONS="$(git diff --name-only --diff-filter=A "$PREVIOUS_SHA" "$TARGET_SHA" -- supabase/migrations/ || true)"

# SUPABASE_DB_URL normalmente não está no ambiente do shell: fica em .env (ou
# no arquivo apontado por NEXOR_ENV, ver scripts/run-wacrm-prod.py), que os
# services systemd carregam por conta própria — update.sh roda fora desse
# caminho. Sem isso, o guard abaixo abortaria em 100% das atualizações com
# migration, mesmo com o valor certo já preenchido em .env, recriando por
# outra via o mesmo travamento permanente que o passo 1 existe para eliminar.
#
# Não fazemos `source .env`: é um arquivo de instalação do cliente, não
# versionado, e um valor com caractere especial (ex.: `$(...)`, crase)
# executaria como comando num shell que dá `source`. scripts/run-wacrm-prod.py
# evita isso de propósito (ver seu docstring) fazendo parsing linha a linha em
# vez de eval/source — replicamos o mesmo parsing aqui, sem tocar em nada além
# de ler o arquivo.
read_env_var() {
  local key="$1" file="$2" line value
  [ -f "$file" ] || return 0
  line="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n1)" || true
  [ -n "$line" ] || return 0
  value="${line#"${key}"=}"
  # remove um par de aspas (simples ou duplas) envolvendo o valor inteiro —
  # mesma regra do loader Python em run-wacrm-prod.py.
  if [[ ( "$value" == \"*\" && "$value" == *\" ) || ( "$value" == \'*\' && "$value" == *\' ) ]]; then
    value="${value:1:-1}"
  fi
  printf '%s' "$value"
}

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  ENV_FILE="${NEXOR_ENV:-$INSTALL_DIR/.env}"
  DB_URL_FROM_FILE="$(read_env_var "SUPABASE_DB_URL" "$ENV_FILE")"
  if [ -n "$DB_URL_FROM_FILE" ]; then
    export SUPABASE_DB_URL="$DB_URL_FROM_FILE"
    echo "==> SUPABASE_DB_URL carregada de $ENV_FILE"
  fi
fi

# Sem SUPABASE_DB_URL (nem no ambiente, nem em .env) o runner
# (scripts/migrate.mjs) não consegue conectar no Postgres do cliente. Se há
# migrations pendentes nesta atualização, aborta aqui — antes do checkout
# --force do passo 4 tocar em qualquer arquivo — em vez de deixar o código
# novo subir e falhar mais adiante contra schema velho.
if [ -n "$NEW_MIGRATIONS" ] && [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "ERRO: esta atualização inclui migrations novas, mas a variável" >&2
  echo "      SUPABASE_DB_URL não está definida (nem no ambiente, nem em" >&2
  echo "      $ENV_FILE):" >&2
  echo "$NEW_MIGRATIONS" | sed 's/^/        - /' >&2
  echo "      Obtenha a connection string em Supabase → Project Settings →" >&2
  echo "      Database → Connection string (a direta do Postgres, não as" >&2
  echo "      chaves NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) e" >&2
  echo "      defina SUPABASE_DB_URL em $ENV_FILE antes de rodar update.sh" >&2
  echo "      novamente." >&2
  exit 1
fi

# Confirma que o serviço está de fato respondendo (não só que o processo subiu).
# Units são Type=simple: `systemctl restart` retorna sucesso assim que o
# processo é forkado, sem esperar a aplicação responder. Por isso todo
# restart (no fluxo principal e no rollback) precisa ser seguido deste check.
run_healthcheck() {
  echo "==> Aguardando o serviço responder..."
  local ok=0
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/version"; then
      ok=1
      break
    fi
    sleep 2
  done
  [ "$ok" -eq 1 ]
}

rollback() {
  # Argumento opcional: aviso extra específico da falha (ex.: estado do banco
  # após falha de migration), impresso antes de qualquer tentativa de
  # restauração para não passar despercebido mesmo se o restante do rollback
  # for direto ao caminho de emergência.
  local extra_msg="${1:-}"
  echo ""
  echo "!!! FALHA NA ATUALIZAÇÃO — restaurando $PREVIOUS_SHA" >&2
  if [ -n "$extra_msg" ]; then
    echo "!!! $extra_msg" >&2
  fi

  local failed_steps=""
  local restart_ok=1

  git checkout --force "$PREVIOUS_SHA" \
    || failed_steps="${failed_steps}  - git checkout --force $PREVIOUS_SHA\n"
  npm ci \
    || failed_steps="${failed_steps}  - npm ci\n"
  npm run build \
    || failed_steps="${failed_steps}  - npm run build\n"
  systemctl --user restart wacrm.service wacrm-worker.service \
    || { failed_steps="${failed_steps}  - systemctl --user restart wacrm.service wacrm-worker.service\n"; restart_ok=0; }

  if [ "$restart_ok" -eq 1 ] && ! run_healthcheck; then
    failed_steps="${failed_steps}  - healthcheck pós-restart: o serviço foi reiniciado, mas não respondeu em http://127.0.0.1:$PORT/api/version\n"
  fi

  if [ -z "$failed_steps" ]; then
    echo "!!! Versão anterior restaurada com sucesso." >&2
    # O aviso do topo já rolou para fora da tela nos logs de git checkout /
    # npm ci / npm run build. Repete em caixa delimitada, no mesmo padrão do
    # bloco de EMERGÊNCIA abaixo, para ser a última coisa que o operador lê —
    # senão "restaurada com sucesso" sozinho passa a impressão (errada) de que
    # o banco também voltou ao estado anterior.
    if [ -n "$extra_msg" ]; then
      {
        echo ""
        echo "############################################################"
        echo "# ATENÇÃO: LEIA ANTES DE CONSIDERAR A RECUPERAÇÃO COMPLETA  #"
        echo "############################################################"
        echo "$extra_msg"
        echo "############################################################"
      } >&2
    fi
    echo "!!! Log completo em $LOG_FILE" >&2
  else
    {
      echo ""
      echo "############################################################"
      echo "# EMERGÊNCIA: A RECUPERAÇÃO AUTOMÁTICA FALHOU               #"
      echo "############################################################"
      echo "O CRM PODE ESTAR FORA DO AR neste momento."
      if [ -n "$extra_msg" ]; then
        echo ""
        echo "$extra_msg"
      fi
      echo ""
      echo "Etapa(s) da recuperação que falharam:"
      echo -e "$failed_steps"
      echo "Rode manualmente, nesta ordem, no servidor (diretório $INSTALL_DIR):"
      echo "  cd $INSTALL_DIR"
      echo "  git checkout --force $PREVIOUS_SHA"
      echo "  npm ci"
      echo "  npm run build"
      echo "  systemctl --user restart wacrm.service wacrm-worker.service"
      echo ""
      echo "Log completo em: $LOG_FILE"
      echo "############################################################"
    } >&2
  fi

  exit 1
}

# 4. Atualizar
git checkout --force "$TARGET_SHA" || rollback
npm ci || rollback

# 4b. Migrations — depois de "npm ci" (garante as dependências do runner, ex.
# o driver `pg`) e antes de "npm run build" e do restart, para o código novo
# nunca subir contra schema velho.
#
# Roda sempre que SUPABASE_DB_URL está definida, não só quando NEW_MIGRATIONS
# aponta arquivo novo: `git diff --diff-filter=A` só enxerga arquivos
# ADICIONADOS entre PREVIOUS_SHA e TARGET_SHA. Se o banco está atrasado por
# qualquer outro motivo — baseline nunca rodado, backup restaurado de um dump
# antigo, migration aplicada manualmente e pela metade — o runner precisa
# rodar mesmo sem arquivo novo no diff. O runner já é idempotente e barato
# ("Nada pendente"), então não custa rodar toda vez. NEW_MIGRATIONS continua
# sendo o único gatilho do abort forçado acima, que é sobre a garantia mínima
# desta atualização específica, não sobre o estado geral do banco.
if [ -n "${SUPABASE_DB_URL:-}" ]; then
  echo "==> Verificando/aplicando migrations pendentes..."
  node scripts/migrate.mjs \
    || rollback "O código foi revertido para $PREVIOUS_SHA. O BANCO DE DADOS PODE NÃO TER SIDO REVERTIDO: dependendo do ponto em que scripts/migrate.mjs falhou, alguma(s) migration(ões) podem ter sido aplicada(s) e continuam no schema — rollback de código não desfaz DDL (outras causas de falha, como TLS ou connection string inválida, não aplicam DDL nenhum; verifique para saber qual foi o caso). Verifique o estado em public.schema_migrations antes de tentar atualizar de novo."
elif [ -n "$NEW_MIGRATIONS" ]; then
  # Não deveria ser alcançável: o guard acima já teria abortado. Mantido como
  # rede de segurança caso a lógica de SUPABASE_DB_URL mude no futuro.
  rollback "Esta atualização inclui migrations novas, mas SUPABASE_DB_URL não estava definida no momento de aplicá-las. O código foi revertido; o banco não foi tocado por este runner."
fi

npm run build || rollback

# 5. Reiniciar
systemctl --user restart wacrm.service wacrm-worker.service || rollback

# 6. Healthcheck
run_healthcheck || rollback

echo ""
echo "==> Atualizado para $TARGET_SHA (origin/$BRANCH) com sucesso."
if [ -n "$NEW_MIGRATIONS" ]; then
  echo "==> Migrations desta atualização aplicadas no passo 4b (ver log acima)."
fi
echo "Log completo: $LOG_FILE"
