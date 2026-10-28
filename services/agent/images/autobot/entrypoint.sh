#!/bin/sh
# Render the small amount of agent configuration the stack owns, then run the agent.
set -eu

: "${AUTOBOT_HOME:=/data}"
: "${INVINCIBLE_HOME:=/invincible}"
: "${GATEWAY_URL:=http://gateway:7777/v1}"
: "${GATEWAY_MODEL:=auto}"
: "${GATEWAY_PRIVATE:=false}"
: "${APPROVALS_MODE:=auto}"
: "${AGENT_SANDBOX:=off}"
: "${AGENT_WORKDIR:=/workspace}"

mkdir -p "$AUTOBOT_HOME" "$AGENT_WORKDIR"
: "${HOME:=/root}"
# The account SSH key makes git push work without a workflow-scoped token (GitHub refuses a
# token push to a branch whose history touches .github/workflows without Workflows:write). The
# GH_TOKEN, when present, is still used by the GitHub API to open the pull request.
if [ -n "${GIT_SSH_KEY_B64:-}" ]; then
  mkdir -p "$HOME/.ssh"
  printf '%s' "$GIT_SSH_KEY_B64" | base64 -d > "$HOME/.ssh/id_ed25519"
  chmod 600 "$HOME/.ssh/id_ed25519"
  git config --global url."git@github.com:".insteadOf "https://github.com/"
  export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
fi

cat > "$AUTOBOT_HOME/config.toml" <<EOF
[agent]
workdir = "$AGENT_WORKDIR"
sandbox = "$AGENT_SANDBOX"

[gateway]
url = "$GATEWAY_URL"
model = "$GATEWAY_MODEL"
private = $GATEWAY_PRIVATE

[approvals]
mode = "$APPROVALS_MODE"
EOF

exec autobot serve
