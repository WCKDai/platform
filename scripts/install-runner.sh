#!/usr/bin/env bash
# Install one persistent GitHub Actions runner for WCKDai on Debian/Ubuntu x86_64.
#
#   sudo RUNNER_NAME=alpha RUNNER_TOKEN=... ./scripts/install-runner.sh
#
# RUNNER_TOKEN is a one-hour, single-use registration token from
# https://github.com/organizations/WCKDai/settings/actions/runners/new
# It is not a PAT and nothing long-lived is stored on the host.
#
# The runner joins the `trusted` group, selected for the explicitly approved
# current repositories. Do not register it before that group is restricted to
# reviewed trusted workflows at their approved refs; see docs/runners.md.
set -euo pipefail

ORG_URL="${ORG_URL:-https://github.com/WCKDai}"
RUNNER_NAME="${RUNNER_NAME:-$(hostname -s)}"
RUNNER_LABEL="${RUNNER_LABEL:-rust-16}"
RUNNER_GROUP="${RUNNER_GROUP:-trusted}"
RUNNER_USER="${RUNNER_USER:-ghrunner}"
RUNNER_DIR="${RUNNER_DIR:-/opt/actions-runner}"
RUNNER_VERSION="${RUNNER_VERSION:-2.338.2}"
RUNNER_SHA256="${RUNNER_SHA256:-baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40}"

LABELS="self-hosted,linux,x64,${RUNNER_LABEL},trusted"

fail() { echo "error: $*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || fail "run as root (sudo)"
[[ -n "${RUNNER_TOKEN:-}" ]] || fail "RUNNER_TOKEN is required"
[[ "$(uname -m)" == "x86_64" ]] || fail "this script installs the x64 runner only"

command -v apt-get >/dev/null || fail "apt-get not found; this script targets Debian/Ubuntu"

echo "== host packages"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  ca-certificates curl git jq tar build-essential clang cmake pkg-config libssl-dev

echo "== runner user"
if ! id -u "$RUNNER_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$RUNNER_USER"
fi

echo "== runner ${RUNNER_VERSION}"
tarball="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
curl -fsSL -o "/tmp/${tarball}" \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${tarball}"
echo "${RUNNER_SHA256}  /tmp/${tarball}" | sha256sum -c -

if [[ -f "${RUNNER_DIR}/.runner" ]]; then
  echo "== removing the previous registration"
  ( cd "$RUNNER_DIR" && ./svc.sh stop >/dev/null 2>&1 || true )
  ( cd "$RUNNER_DIR" && ./svc.sh uninstall >/dev/null 2>&1 || true )
  rm -f "${RUNNER_DIR}/.runner" "${RUNNER_DIR}/.credentials" "${RUNNER_DIR}/.credentials_rsaparams"
fi

install -d -o "$RUNNER_USER" -g "$RUNNER_USER" "$RUNNER_DIR"
tar xzf "/tmp/${tarball}" -C "$RUNNER_DIR"
chown -R "${RUNNER_USER}:${RUNNER_USER}" "$RUNNER_DIR"
rm -f "/tmp/${tarball}"

# Debian 13 does not ship the ICU that the runner's bundled .NET needs;
# config.sh fails with "Libicu's dependencies is missing" without this.
echo "== runner dependencies"
"${RUNNER_DIR}/bin/installdependencies.sh" >/dev/null

echo "== registration"
sudo -u "$RUNNER_USER" "${RUNNER_DIR}/config.sh" \
  --unattended \
  --replace \
  --url "$ORG_URL" \
  --token "$RUNNER_TOKEN" \
  --name "$RUNNER_NAME" \
  --labels "$LABELS" \
  --runnergroup "$RUNNER_GROUP" \
  --work "${RUNNER_DIR}/_work"

echo "== systemd service"
( cd "$RUNNER_DIR" && ./svc.sh install "$RUNNER_USER" )
unit="actions.runner.WCKDai.${RUNNER_NAME}.service"
install -d "/etc/systemd/system/${unit}.d"
cat >"/etc/systemd/system/${unit}.d/limits.conf" <<'EOF'
[Service]
LimitNOFILE=131072
EOF
systemctl daemon-reload
( cd "$RUNNER_DIR" && ./svc.sh start )
( cd "$RUNNER_DIR" && ./svc.sh status ) || true

cat <<EOF

Runner "${RUNNER_NAME}" is registered with labels:
  ${LABELS}

Check it in GitHub:
  https://github.com/organizations/WCKDai/settings/actions/runners

The registration token is already spent. Keep the runner package and toolchains
patched from the maintenance job; do not add long-lived provider credentials to
${RUNNER_USER}'s environment.
EOF
