#!/bin/sh
# Deploy the agent stack to a named host over SSH. The host must already have Docker Engine and
# Compose v2, and /opt/wckd-agent/.env must hold the values from .env.example.
#
#   ALPHA_HOST=203.0.113.10 ALPHA_USER=root scripts/deploy-alpha.sh
#   ALPHA_HOST=alpha.example ALPHA_USER=deploy ALPHA_PORT=2222 scripts/deploy-alpha.sh
set -eu

: "${ALPHA_HOST:?set ALPHA_HOST to the server name or address}"
: "${ALPHA_USER:=root}"
: "${ALPHA_PORT:=22}"
: "${REMOTE_DIR:=/opt/wckd-agent}"

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -x images/autobot/bin/autobot ]; then
  echo "images/autobot/bin/autobot is missing; running fetch-linux-binaries.sh"
  scripts/fetch-linux-binaries.sh "${VERSION:-v0.0.27}" "$(uname -m)"
fi

SSH="ssh -o BatchMode=yes -o ConnectTimeout=10 -p $ALPHA_PORT"
TARGET="$ALPHA_USER@$ALPHA_HOST"

echo "==> checking $TARGET"
$SSH "$TARGET" 'command -v docker >/dev/null && docker compose version >/dev/null'

echo "==> syncing $ROOT to $TARGET:$REMOTE_DIR"
$SSH "$TARGET" "mkdir -p '$REMOTE_DIR'"
rsync -az --delete \
  --exclude '.env' --exclude 'data/' --exclude 'workspace/' --exclude 'images/autobot/bin/' \
  -e "ssh -o BatchMode=yes -p $ALPHA_PORT" \
  ./ "$TARGET:$REMOTE_DIR/"

if [ -n "${GHCR_TOKEN:-}" ]; then
  echo "==> logging in to GHCR on $TARGET"
  printf '%s' "$GHCR_TOKEN" | $SSH "$TARGET" "docker login ghcr.io -u '${GHCR_USER:-$ALPHA_USER}' --password-stdin"
fi

echo "==> checking the remote environment"
$SSH "$TARGET" "cd '$REMOTE_DIR' && test -f .env || { echo 'missing $REMOTE_DIR/.env; copy .env.example and fill it on the host' >&2; exit 1; }"

echo "==> pulling and starting"
$SSH "$TARGET" "cd '$REMOTE_DIR' && docker compose pull && docker compose up -d --build --remove-orphans && docker compose ps"

echo "==> deployed. Follow logs with:"
echo "    ssh -p $ALPHA_PORT $TARGET 'cd $REMOTE_DIR && docker compose logs -f panel agent caddy'"
