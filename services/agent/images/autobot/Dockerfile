FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY bin/autobot /usr/local/bin/autobot
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /usr/local/bin/autobot /entrypoint.sh

ENV AUTOBOT_HOME=/data \
    INVINCIBLE_HOME=/invincible \
    GATEWAY_URL=http://gateway:7777/v1 \
    APPROVALS_MODE=auto \
    AGENT_WORKDIR=/workspace

VOLUME ["/data", "/workspace"]
EXPOSE 7792

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7792/healthz >/dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
