# Agent stack: Autobot + Invincible control

A self-hosted agent deployment: Autobot behind Caddy, with an authenticated control panel, on a
host that runs Docker. Invincible remains the gateway; point the stack at the node that serves the
models and holds the token.

```text
                    Caddy :80/:443
                         │
                    panel :7800        authenticated humans
                         │
                    agent :7792        Autobot API
                         │
              Invincible gateway :7777  models, policy, receipts
```

The gateway is deliberately not in this compose file. Deploying a model server is a different
lifecycle from deploying an agent, and a 15 GB model should not move because the panel changed.
Point `GATEWAY_URL` at an Invincible node on the same host, on the private network, or across
Tailscale. The node's token is mounted read-only from `INVINCIBLE_DATA`.

## First deploy

```bash
cd services/agent
cp .env.example .env
# edit .env: domain, token, password hash, secret

panel/scripts/hash-password.mjs 'a long operator password'
# put the printed scrypt:... in PANEL_PASSWORD_HASH

scripts/fetch-linux-binaries.sh v0.0.22 x86_64
docker compose config
docker compose up -d --build
docker compose ps
curl -fsS https://"$PANEL_DOMAIN"/healthz
```

`fetch-linux-binaries.sh` takes `autobot` from the published `invincible` release; the same tarball
also contains `invincible` if the gateway is installed on the same host. The agent image is
`debian:bookworm-slim` with only `ca-certificates`, `curl`, and the binary.

## What the stack owns

| Path | Contents |
| --- | --- |
| `agent-data` Docker volume | Autobot conversations, memory, skills, schedules |
| `${WORKSPACE}` on the host | the project directory Autobot edits |
| `${INVINCIBLE_DATA}` read-only | the gateway token Autobot reads (`/invincible/token`) |
| `caddy-data` | TLS certificates and ACME state |

The agent runs with `APPROVALS_MODE=auto` by default: interactive coding can edit the workspace,
while scheduled/board work still downgrades to `allowlist`. Set `APPROVALS_MODE=edits` or
`allowlist` for a tighter default.

## API and panel

The Autobot API is not published to the host. The panel proxies the read and approval calls it
needs; it never exposes `/v1/agent` directly and never returns the gateway token. See
[`panel/README.md`](panel/README.md) for the panel's routes and security model.

## Deploy through Coolify (the alpha path)

The platform's `infra` environment holds the Coolify server and project variables for PolyCore and
Polykrom. The `deploy-agent-coolify` workflow uses them; no local SSH or Hetzner token is needed:

```sh
gh workflow run deploy-agent-coolify.yml -R WCKDai/platform --ref main
# optionally: -f domain=agent.example.com
```

It creates (or reuses) the `agent-panel` Docker Compose application in the PolyCore project from
`services/agent/docker-compose.coolify.yml`, sets `CLOUD_BASE_URL`, `CLOUD_MODEL` and the LiteLLM
key, and deploys it. The stack is:

- **gateway:** Invincible, cloud-only, in front of the existing `llm.polykrom.app` LiteLLM gateway;
- **agent:** Autobot, using the gateway with its own token and `private = false`;
- **panel:** the authenticated control panel, public through Coolify's Traefik.

Coolify generates the gateway token, panel password and session secret; find them in the
application's **Environment** tab. The default public URL is
`https://agent.<server-ip>.sslip.io`; pass the optional `domain` input to use a real domain.
The workflow waits for `running:healthy` and then checks `/healthz`.

This uses LiteLLM for model access, so it proves the agent + gateway + panel path without a GPU on
the worker. To use a local model later, replace the gateway service with an engine-bearing image
and set `GATEWAY_URL` to it; the agent and panel do not change.

## Deploying to a host over SSH

There is no usable `alpha` SSH alias, DNS record, or Hetzner API token on the development machine
as of 2026-10-28. Do not repurpose an unrelated host: name the target explicitly first.

Once the host is named, use either:

```bash
ALPHA_HOST=... ALPHA_USER=root ./scripts/deploy-alpha.sh
```

or the gated **agent-stack** workflow in `.github/workflows/agent-stack.yml` (environment
`alpha`, with `ALPHA_HOST`, `ALPHA_USER`, `ALPHA_SSH_KEY`, and `ALPHA_DEPLOY=true`). The workflow
builds the panel and agent images, pushes them to GHCR, then pulls and restarts on the host. The
deploy job is skipped unless `ALPHA_DEPLOY` is explicitly true.

The images are private by default. Set `GHCR_TOKEN` (a token with `read:packages`) and
`GHCR_USER` in the alpha environment, or make the two packages public, then the workflow (or
`GHCR_TOKEN=... GHCR_USER=... ./scripts/deploy-alpha.sh`) logs in before `docker compose pull`.
If you prefer to build on the host, run `docker compose up -d --build` with
`images/autobot/bin/autobot` present.

## Verification

- `docker compose config` — required values and network wiring.
- `panel` local smoke test — login, overview, CSRF, logout, bad password, 401s.
- `curl https://$PANEL_DOMAIN/healthz` — after deploy.
- `autobot doctor` through the agent container — model, sandbox and gateway.
- A first task from the panel, then `docker compose logs -f agent panel caddy`.

The stack has not been deployed to a Hetzner host from this checkout: the environment was not
reachable and no alpha credentials exist here. The local stack and panel are tested; the compose
file is ready for a named host.
