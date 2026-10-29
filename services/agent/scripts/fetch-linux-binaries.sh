#!/bin/sh
# Put the published Linux binaries beside the agent Dockerfile.
# Usage: scripts/fetch-linux-binaries.sh [version] [arch]
set -eu

VERSION="${1:-v0.0.27}"
ARCH="${2:-$(uname -m)}"
case "$ARCH" in
  x86_64|amd64) ASSET=invincible-linux-x64.tar.gz ;;
  arm64|aarch64) ASSET=invincible-linux-arm64.tar.gz ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 2 ;;
esac

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DEST="$ROOT/images/autobot/bin"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$DEST"

URL="https://github.com/wckdboy/invincible/releases/download/$VERSION/$ASSET"
echo "fetching $URL"
curl -fsSL "$URL" -o "$TMP/$ASSET"
tar -xzf "$TMP/$ASSET" -C "$TMP"
cp "$TMP/invincible-linux-${ARCH%%[0-9]*}/autobot" "$DEST/autobot" 2>/dev/null || {
  # The archive directory is named for the release platform; find it rather than guess.
  found="$(find "$TMP" -type f -name autobot -perm -u+x | head -1)"
  [ -n "$found" ] || { echo "autobot not found in $ASSET" >&2; exit 1; }
  cp "$found" "$DEST/autobot"
}
chmod 0755 "$DEST/autobot"
echo "wrote $DEST/autobot"
