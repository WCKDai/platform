#!/bin/sh
# Render the small amount of agent configuration the stack owns, then run the agent.
set -eu

: "${AUTOBOT_HOME:=/data}"
: "${INVINCIBLE_HOME:=/invincible}"
: "${GATEWAY_URL:=http://gateway:7777/v1}"
: "${APPROVALS_MODE:=auto}"
: "${AGENT_WORKDIR:=/workspace}"

mkdir -p "$AUTOBOT_HOME" "$AGENT_WORKDIR"

cat > "$AUTOBOT_HOME/config.toml" <<EOF
[agent]
workdir = "$AGENT_WORKDIR"

[gateway]
url = "$GATEWAY_URL"
private = true

[approvals]
mode = "$APPROVALS_MODE"
EOF

exec autobot serve
