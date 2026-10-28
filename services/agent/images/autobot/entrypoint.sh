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
