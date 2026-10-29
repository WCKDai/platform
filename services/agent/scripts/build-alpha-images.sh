#!/bin/sh
# Build the three agent-stack images on the alpha host and push them to its local registry.
#
# The GHCR packages are private and the Coolify worker has no registry credential, so the alpha
# uses a registry bound to the host's loopback. Run this after changing services/agent, then
# deploy the `agent-panel` application in Coolify (or run the deploy-agent-coolify workflow).
#
#   ALPHA_HOST=root@62.83.75.115 ./scripts/build-alpha-images.sh
#
# The host needs Docker, git and network access to the GitHub release and to github.com.
set -eu

HOST="${ALPHA_HOST:?set ALPHA_HOST, for example root@62.83.75.115}"
VERSION="${VERSION:-v0.0.25}"
REGISTRY="${REGISTRY:-127.0.0.1:5000}"
SRC="${SRC:-/opt/wckd-agent-src}"

ssh -o BatchMode=yes "$HOST" sh -s -- "$VERSION" "$REGISTRY" "$SRC" <<'REMOTE'
set -eu
VERSION="$1"
REGISTRY="$2"
SRC="$3"

if ! docker inspect wckd-registry >/dev/null 2>&1; then
  docker run -d --restart unless-stopped --name wckd-registry \
    -p 127.0.0.1:5000:5000 -v wckd-registry-data:/var/lib/registry registry:2 >/dev/null
fi
i=0
until curl -fsS http://127.0.0.1:5000/v2/ >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 30 ] || { echo "the local registry did not start" >&2; exit 1; }
  sleep 1
done

if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch --depth 1 origin main
  git -C "$SRC" reset --hard origin/main
else
  git clone --depth 1 https://github.com/WCKDai/platform.git "$SRC"
fi

cd "$SRC/services/agent"
case "$(uname -m)" in
  x86_64) arch=x86_64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac
scripts/fetch-linux-binaries.sh "$VERSION" "$arch"

docker build -t "$REGISTRY/wckd-autobot:latest" images/autobot
docker build -t "$REGISTRY/wckd-agent-panel:latest" panel
docker build -t "$REGISTRY/wckd-invincible-gateway:latest" images/gateway
for image in wckd-autobot wckd-agent-panel wckd-invincible-gateway; do
  docker push "$REGISTRY/$image:latest"
done
docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | grep "^$REGISTRY/"
REMOTE
