# Agent stack: Autobot + Invincible control

A self-hosted agent deployment: Autobot behind Caddy, with an authenticated control panel, on a
Linux host that runs Docker and Invincible.

```text
                    Caddy :80/:443
                         │
                    panel 127.0.0.1:7800   authenticated humans
                         │
                    agent 127.0.0.1:7792   Autobot API
                         │
              Invincible gateway 127.0.0.1:7777   models, policy, receipts
```

The gateway is deliberately not in this host-networking compose file. Deploying a model server is
a different lifecycle from deploying an agent, and a 15 GB model should not move because the panel
changed. The Coolify compose below does include a cloud-only gateway because the alpha worker has
no local model.

Invincible and Autobot both listen only on loopback by design: paired devices reach the agent
through the gateway. A normal Docker bridge would put the containers on another host, where
`127.0.0.1` is not the node, so the agent, panel and Caddy use **host networking** and share the
host's loopback with Invincible. This needs a Linux Docker host; Docker Desktop on macOS keeps
containers in a VM and cannot reach the macOS host's loopback.

Install Invincible on the host (`curl -fsSL https://invincible.sh/install.sh | sh`), then give the
stack its token. The node's token is mounted read-only from `INVINCIBLE_DATA`.

## First deploy

```bash
cd services/agent
cp .env.example .env
# edit .env: domain, token, password hash, secret

panel/scripts/hash-password.mjs 'a long operator password'
# put the printed scrypt:... in PANEL_PASSWORD_HASH

scripts/fetch-linux-binaries.sh v0.0.26 x86_64
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

The panel binds `127.0.0.1:7800`, the agent `127.0.0.1:7792`, and Caddy owns `:80`/`:443`. None of
the internal ports is reachable from another machine.

The agent runs with `APPROVALS_MODE=auto` by default: interactive coding can edit the workspace,
while scheduled/board work still downgrades to `allowlist`. Set `GH_TOKEN` (repository contents
and pull-request write) for one-click pull requests; without it, a thread's branch is still pushed
when git has credentials, and the compare link is returned. Set `APPROVALS_MODE=edits` or
`allowlist` for a tighter default.

The container config sets `[agent] sandbox = "off"`: a normal Docker container cannot create the
user and mount namespaces `bwrap` needs (it fails with `Operation not permitted`), so the container
is the boundary. Unattended commands therefore run inside the agent container, not in a second
sandbox. Run Autobot directly on the host, or give the container the privileges bwrap needs, if you
want the inner sandbox as well. For a throwaway container this is the intended trade.

## API and panel

The Autobot API is not published beyond the host: it binds `127.0.0.1:7792` in the host's network
namespace. The panel proxies the calls it needs (overview, sessions, turns, approvals, threads,
settings, tools, secrets, bots, usage) and never exposes the raw `/v1/agent` surface or the
gateway token. The rooms are Overview, Chat, Workspaces, Bots, Integrations, Usage and Settings;
see [`panel/README.md`](panel/README.md) for the routes and security model.

A thread is a session plus a git worktree under `$AUTOBOT_HOME/worktrees` and a branch
`autobot/<id>`, made from the bot's workdir. The agent image includes `git`; the workdir must be a
git repository. `thread pr` commits, pushes and opens a pull request with `gh` or the GitHub API
(`GH_TOKEN`/`GITHUB_TOKEN`), or returns the compare link after the push. The panel's **Workspaces**
room does the same with clicks. The agent container is the boundary; see the sandbox note above.

## GitHub credentials for thread PRs

`thread pr` commits and pushes a branch, then opens a pull request. Without a credential the push
fails. The preferred credential is a **fine-grained personal access token** with `Contents: write`
and `Pull requests: write` on the project repository. Set it with the idempotent helper:

```sh
GH_TOKEN=github_pat_… ./scripts/setup-alpha-git.sh
gh workflow run deploy-agent-coolify.yml -R WCKDai/platform --ref main
```

The script writes `AGENT_GH_TOKEN` in the `infra` environment; the deploy workflow puts it in the
Coolify application as `GH_TOKEN`. With **Contents** and **Pull requests** write, the token opens
the pull request; with **Workflows: Read and write** as well, it pushes the branch too. The token
reaches only the agent container; the browser and the panel never see it.

This repository's branch history touches `.github/workflows`, so a token without Workflows write
is refused when pushing; an account SSH key (`GIT_SSH_KEY_B64`) is the fallback for the push while
the token still opens the PR. The current alpha uses the PAT alone, with Workflows write. Add the
permission to make the token self-sufficient; use the SSH fallback if you would rather not grant
it.

Without a token, `./scripts/setup-alpha-git.sh` generates an **account SSH key** and stores it as
`AGENT_GIT_SSH_KEY_B64`. The push then works over SSH, but the panel can only return the compare
link (the GitHub API needs a token). The account key can push to any repository the account can
write to; the script prints the revocation commands. Repeat runs change nothing while either
secret exists; delete the secret (and the key) to rotate.

The token is not a model provider key: provider keys still live in the gateway. It is a repository
credential, so use a fine-grained token scoped to the project and the two permissions above.

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
`https://agent.invincible.sh`; pass the optional `domain` input to change it.
The workflow waits for `running:healthy` and then checks `/healthz`.

The images are built by `.github/workflows/agent-images.yml` and published as **public, signed
release assets** (the container tarballs, `SHA256SUMS` and its Ed25519 signature). The alpha
verifies and loads them; it never contacts a registry:

```sh
gh workflow run agent-images.yml -R WCKDai/platform -f version=v0.0.26
ALPHA_HOST=root@62.83.75.115 ./scripts/load-alpha-images.sh
gh workflow run deploy-agent-coolify.yml -R WCKDai/platform
```

`load-alpha-images.sh` pins the public key in `RELEASE_KEY.pub` (fingerprint
`SHA256:pUnu93DCCD+JwjrBHZLb+syi8tFMR/SpScWVwHGJvrQ`), verifies `SHA256SUMS` against the
release's signature, loads the three images as `wckd-agent-stack/*:v0.0.26`, and checks their
tags. To rotate the key, replace `RELEASE_KEY.pub`, set the `AGENT_IMAGES_SIGNING_KEY` secret to
the new private key, pin the new public key in `load-alpha-images.sh`, and publish a new
`agent-images-*` release. The compose uses `pull_policy: never`, and the deploy workflow sets Coolify's
`docker_compose_custom_build_command` to a no-op `echo`, so Coolify skips its pre-deploy pull. No
registry credential, loopback registry or private GHCR access is involved. The GHCR packages from
`agent-stack.yml` remain optional and are not used by the alpha.

This uses LiteLLM for model access, so it proves the agent + gateway + panel path without a GPU on
the worker. To use a local model later, replace the cloud block in the gateway service with an
engine-bearing image; the agent and panel do not change.

## Deploying to a host over SSH

The alpha host is the Coolify worker `alpha` at `62.83.75.115`; `root` SSH works from the
development machine. The Coolify path is the one in use. The host-networking compose below is the
alternative for a dedicated Linux node that runs Invincible on the host itself.

```bash
ALPHA_HOST=... ALPHA_USER=root ./scripts/deploy-alpha.sh
```

The **agent-stack** workflow tests and publishes optional GHCR images; the alpha uses the signed
release tarballs above, not GHCR. The host-networking compose can still build locally with
`docker compose up -d --build` and `images/autobot/bin/autobot` present. `deploy-alpha.sh` is for
that dedicated-host path, not the Coolify alpha.

## Verification

- `docker compose config` — required values and network wiring.
- `panel` local smoke test — login, overview, CSRF, logout, bad password, 401s.
- `curl https://$PANEL_DOMAIN/healthz` — after deploy.
- `autobot doctor` through the agent container — gateway, a model answer, tools and the
  `sandbox = "off"` mode. The host-only `invincible` and `llama-server` checks are absent by
  design: the gateway runs in its own container and the models come from LiteLLM.
- A first task from the panel, then `docker compose logs -f agent panel caddy`.

The 0.0.26 alpha stack is deployed through Coolify at
`https://agent.invincible.sh` and was verified on 2026-10-29. The images are the public signed
release tarballs from `agent-images-v0.0.26`; `pull_policy: never` keeps Coolify and Docker off
every registry.

- all three containers healthy (`gateway`, `agent`, `panel`); both binaries report `0.0.26`;
- Let's Encrypt on the origin and a Cloudflare edge certificate on the public name;
- login 303, dashboard and `/api/overview` 200, a missing CSRF token 403, logout 200;
- the panel's rooms load: Overview, Chat, Workspaces, Bots, Integrations, Usage and Settings;
- an answer turn returned `alpha` with a gateway receipt; a tool turn wrote a file in `/workspace`;
- a thread was created from the project in `/workspace`, a tool task wrote inside its worktree,
  the panel streamed the live turn with diffs and tool outputs, and **PR** committed, pushed and
  opened a real GitHub pull request through the PAT alone (Workflows write); the panel returned
  `pr_url`/`pr_number`; the test PR was closed, its branch deleted and the thread removed;
- Playwright drove the chat and thread flows with no page errors;
- a delegated **Keep going** run listed `/workspace` and reported its summary;
- a delegated run whose task said "ask me, do not guess, then wait for my answer" showed
  `delegated: questions go to you`, made no nudge, created no file, and ended waiting for the
  owner; the panel's assets carry a content hash, so the new panel appeared immediately after the
  deploy.
- `invincible update` on the local Mac restarted both launchd services, and the new reload path
  recovered a booted-out job and a changed definition without `service uninstall`.

`/workspace` holds a clone of the public `WCKDai/platform` repository as the working demo
project; replace it with the project the bot should work on. The panel password, gateway token
and session secret are in the Coolify application's **Environment** tab. Test files and sessions
were cleaned up; the panel login was logged out.
