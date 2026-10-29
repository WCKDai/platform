#!/bin/sh
# Download the public, signed agent-stack images from GitHub Releases and load them on the alpha
# host. Run this before deploy-agent-coolify.yml; Coolify uses pull_policy: never, so it never
# contacts a registry.
#
#   ALPHA_HOST=root@62.83.75.115 ./scripts/load-alpha-images.sh
#   VERSION=v0.1.0 ALPHA_HOST=root@62.83.75.115 ./scripts/load-alpha-images.sh
#
# The release is built by .github/workflows/agent-images.yml. The public key is pinned here, not
# fetched from the release, so a changed release cannot change the key that verifies it.
set -eu

HOST="${ALPHA_HOST:?set ALPHA_HOST, for example root@62.83.75.115}"
VERSION="${VERSION:-v0.0.31}"

ssh -o BatchMode=yes "$HOST" sh -s -- "$VERSION" <<'REMOTE'
set -eu
VERSION="$1"
BASE="https://github.com/WCKDai/platform/releases/download/agent-images-$VERSION"
IMAGES="wckd-invincible-gateway wckd-autobot wckd-agent-panel"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

echo "fetching agent-images-$VERSION from the public release"
curl -fsSL "$BASE/SHA256SUMS" -o SHA256SUMS
curl -fsSL "$BASE/SHA256SUMS.sig" -o SHA256SUMS.sig
curl -fsSL "$BASE/VERSION" -o VERSION
# Pinned here, not fetched from the release.
printf '%s\n' 'agent-images-release ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPcmzGvVZ54D6Q2C3VmvaYWJkadXdrgazCwzsx97ebY7 agent-images-release' > allowed_signers
ssh-keygen -Y verify -f allowed_signers -I agent-images-release \
  -n agent-images-release -s SHA256SUMS.sig < SHA256SUMS
[ "$(cat VERSION)" = "$VERSION" ] || {
  echo "the release says $(cat VERSION), expected $VERSION" >&2
  exit 1
}

for image in $IMAGES; do
  echo "fetching $image-$VERSION.tar.gz"
  curl -fsSL "$BASE/$image-$VERSION.tar.gz" -o "$image-$VERSION.tar.gz"
done
sha256sum -c SHA256SUMS

for image in $IMAGES; do
  echo "loading $image"
  gzip -dc "$image-$VERSION.tar.gz" | docker load
  docker image inspect "wckd-agent-stack/$image:$VERSION" >/dev/null
done

echo "loaded wckd-agent-stack/{$IMAGES}:$VERSION; deploy with deploy-agent-coolify.yml"
REMOTE
