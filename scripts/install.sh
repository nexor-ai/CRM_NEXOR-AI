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

# 4. Dependências e build
echo "==> Instalando dependências..."
cd "$INSTALL_DIR"
npm ci
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
  echo "    1. Preencha $INSTALL_DIR/.env"
  echo "    2. Rode: systemctl --user enable --now wacrm.service wacrm-worker.service"
  exit 0
fi

systemctl --user enable --now wacrm.service wacrm-worker.service
echo ""
echo "==> Pronto. NEXOR CRM rodando em http://127.0.0.1:$PORT"
echo "    Status: systemctl --user status wacrm.service"
