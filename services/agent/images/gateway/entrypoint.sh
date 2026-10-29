#!/bin/sh
# Invincible as a cloud-only gateway: no local engine, models come from the LiteLLM host.
set -eu

: "${INVINCIBLE_HOME:=/data}"
: "${INVINCIBLE_TOKEN:?INVINCIBLE_TOKEN is required}"
: "${CLOUD_BASE_URL:?CLOUD_BASE_URL is required (for example https://llm.polykrom.app/v1)}"
: "${CLOUD_MODEL:?CLOUD_MODEL is required (the LiteLLM alias, for example cheap)}"
: "${CLOUD_API_KEY:?CLOUD_API_KEY is required}"
: "${CLOUD_CONTEXT:=65536}"

mkdir -p "$INVINCIBLE_HOME"
umask 077
printf '%s\n' "$INVINCIBLE_TOKEN" > "$INVINCIBLE_HOME/token"

if [ ! -f "$INVINCIBLE_HOME/config.toml" ] || [ "${INVINCIBLE_CONFIG_FORCE:-0}" = "1" ]; then
  cat > "$INVINCIBLE_HOME/config.toml" <<EOF
[node]
network = "direct"
egress = "auto"

[[cloud]]
id = "$CLOUD_MODEL"
base_url = "$CLOUD_BASE_URL"
upstream_model = "$CLOUD_MODEL"
api_key_env = "CLOUD_API_KEY"
context = $CLOUD_CONTEXT
data_policy = "unknown"
EOF
else
  # Providers added from the panel are written here; keep them across restarts. Set
  # INVINCIBLE_CONFIG_FORCE=1 on the service to regenerate from the environment instead.
  echo "keeping $INVINCIBLE_HOME/config.toml (set INVINCIBLE_CONFIG_FORCE=1 to regenerate)"
fi

exec invincible serve
