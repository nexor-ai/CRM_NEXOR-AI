#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$PROJECT_DIR/dist"
PACKAGE_NAME="nexor-crm-$(basename "$PROJECT_DIR")-$(git -C "$PROJECT_DIR" rev-parse --short=12 HEAD).tar.gz"

mkdir -p "$DIST_DIR"

if [[ ! -d "$PROJECT_DIR/.next-production" ]]; then
  echo "Build de produção não encontrado em $PROJECT_DIR/.next-production" >&2
  echo "Execute: python3 scripts/promote-wacrm-production.py" >&2
  exit 1
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

mkdir -p "$TMPDIR/nexor-crm"
cp -a "$PROJECT_DIR/.next-production" "$TMPDIR/nexor-crm/.next-production"
cp -a "$PROJECT_DIR/public" "$TMPDIR/nexor-crm/public" 2>/dev/null || true
mkdir -p "$TMPDIR/nexor-crm/scripts"
cp "$PROJECT_DIR/scripts/run-wacrm-prod.py" "$TMPDIR/nexor-crm/scripts/"
cp "$PROJECT_DIR/scripts/run-wacrm-worker.py" "$TMPDIR/nexor-crm/scripts/"
cp "$PROJECT_DIR/.env.local.example" "$TMPDIR/nexor-crm/.env" 2>/dev/null || true
cp "$PROJECT_DIR/package.json" "$TMPDIR/nexor-crm/"
cp "$PROJECT_DIR/package-lock.json" "$TMPDIR/nexor-crm/" 2>/dev/null || true

tar -C "$TMPDIR" -czf "$DIST_DIR/$PACKAGE_NAME" nexor-crm

echo "Pacote criado: $DIST_DIR/$PACKAGE_NAME"
echo ""
echo "Para enviar ao cliente:"
echo "  scp $DIST_DIR/$PACKAGE_NAME usuario@servidor:/opt/nexor-crm/"
echo ""
echo "Ou hospede em release e envie o link."
