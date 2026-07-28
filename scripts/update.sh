#!/usr/bin/env bash
# Atualiza o NEXOR CRM para a última release publicada, com rollback automático.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$INSTALL_DIR"

PORT="${PORT:-3010}"
LOG_DIR="$INSTALL_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/update-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "==> NEXOR CRM — atualização iniciada em $(date)"

# 1. Não atropelar alterações locais do cliente
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERRO: existem alterações locais não commitadas neste diretório." >&2
  echo "      Salve ou descarte essas alterações antes de atualizar." >&2
  git status --short >&2
  exit 1
fi

PREVIOUS_SHA="$(git rev-parse HEAD)"
echo "==> Versão atual: $PREVIOUS_SHA"

# 2. Buscar a última release
git fetch --tags --prune origin
LATEST_TAG="$(git tag -l 'v*' --sort=-v:refname | head -n1)"
if [ -z "$LATEST_TAG" ]; then
  echo "ERRO: nenhuma tag de release encontrada no repositório." >&2
  exit 1
fi
echo "==> Última release: $LATEST_TAG"

if [ "$(git rev-parse "$LATEST_TAG")" = "$PREVIOUS_SHA" ]; then
  echo "==> Já está na versão mais recente. Nada a fazer."
  exit 0
fi

# 3. Migrations que entram nesta atualização
NEW_MIGRATIONS="$(git diff --name-only --diff-filter=A "$PREVIOUS_SHA" "$LATEST_TAG" -- supabase/migrations/ || true)"

rollback() {
  echo ""
  echo "!!! FALHA NA ATUALIZAÇÃO — restaurando $PREVIOUS_SHA" >&2

  local failed_steps=""

  git checkout --force "$PREVIOUS_SHA" \
    || failed_steps="${failed_steps}  - git checkout --force $PREVIOUS_SHA\n"
  npm ci \
    || failed_steps="${failed_steps}  - npm ci\n"
  npm run build \
    || failed_steps="${failed_steps}  - npm run build\n"
  systemctl --user restart wacrm.service wacrm-worker.service \
    || failed_steps="${failed_steps}  - systemctl --user restart wacrm.service wacrm-worker.service\n"

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
git checkout --force "tags/$LATEST_TAG" || rollback
npm ci || rollback
npm run build || rollback

# 5. Reiniciar
systemctl --user restart wacrm.service wacrm-worker.service || rollback

# 6. Healthcheck
echo "==> Aguardando o serviço responder..."
OK=0
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/version"; then
    OK=1
    break
  fi
  sleep 2
done
[ "$OK" -eq 1 ] || rollback

echo ""
echo "==> Atualizado para $LATEST_TAG com sucesso."

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
