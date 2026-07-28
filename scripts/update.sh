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

# 1. Não atropelar alterações locais do cliente
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERRO: existem alterações locais não commitadas neste diretório." >&2
  echo "      Salve ou descarte essas alterações antes de atualizar." >&2
  git status --short >&2
  exit 1
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
  echo ""
  echo "!!! FALHA NA ATUALIZAÇÃO — restaurando $PREVIOUS_SHA" >&2

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
    echo "!!! Versão anterior restaurada com sucesso. Log completo em $LOG_FILE" >&2
  else
    {
      echo ""
      echo "############################################################"
      echo "# EMERGÊNCIA: A RECUPERAÇÃO AUTOMÁTICA FALHOU               #"
      echo "############################################################"
      echo "O CRM PODE ESTAR FORA DO AR neste momento."
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
npm run build || rollback

# 5. Reiniciar
systemctl --user restart wacrm.service wacrm-worker.service || rollback

# 6. Healthcheck
run_healthcheck || rollback

echo ""
echo "==> Atualizado para $TARGET_SHA (origin/$BRANCH) com sucesso."

if [ -n "$NEW_MIGRATIONS" ]; then
  echo ""
  echo "############################################################"
  echo "# ATENÇÃO: esta versão inclui migrations de banco novas.    #"
  echo "# Aplique-as no Supabase antes de usar o CRM:               #"
  echo "############################################################"
  echo "$NEW_MIGRATIONS" | sed 's/^/  - /'
  echo ""
fi

echo "Log completo: $LOG_FILE"
