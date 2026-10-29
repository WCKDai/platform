FROM debian:bookworm-slim

ARG INVINCIBLE_VERSION=v0.0.28

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  arch="$(uname -m)"; \
  case "$arch" in \
    x86_64|amd64) asset=invincible-linux-x64.tar.gz; dir=invincible-linux-x64 ;; \
    aarch64|arm64) asset=invincible-linux-arm64.tar.gz; dir=invincible-linux-arm64 ;; \
    *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/wckdboy/invincible/releases/download/${INVINCIBLE_VERSION}/${asset}" -o /tmp/inv.tar.gz; \
  tar -xzf /tmp/inv.tar.gz -C /tmp; \
  install -m 0755 "/tmp/${dir}/invincible" /usr/local/bin/invincible; \
  rm -rf /tmp/inv.tar.gz "/tmp/${dir}"

COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh

ENV INVINCIBLE_HOME=/data
VOLUME ["/data"]
EXPOSE 7777

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7777/healthz >/dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
