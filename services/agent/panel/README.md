# Invincible control panel

One authenticated surface for an Invincible gateway and an Autobot agent. It is a small Node
process with no runtime dependencies and no build step.

- **Gateway:** models, health, node identity, and the recent audit/receipt stream.
- **Agent:** bot/version, tasks, open sessions, waiting approvals, conversations.
- **Approvals:** answer `once`, `always` or `deny` from the panel.
- **Run a task:** start or continue an Autobot conversation and stream its output.
- **History:** read a conversation's messages.

The panel never receives a provider key. It holds one Invincible API token, and only the server
side uses it. The browser sees the panel's own session cookie and a CSRF token.

## Run it

```bash
cd services/agent/panel
export INVINCIBLE_TOKEN="$(invincible token)"
export PANEL_PASSWORD_HASH="$(node scripts/hash-password.mjs 'a long operator password')"
export PANEL_SECRET="$(openssl rand -hex 32)"
export GATEWAY_URL=http://127.0.0.1:7777/v1
export AGENT_URL=http://127.0.0.1:7792
node server.mjs
```

Open <http://127.0.0.1:7800>. For a local HTTP test set `PANEL_SECURE_COOKIES=false`. In
production Caddy terminates TLS, `PANEL_SECURE_COOKIES=true`, and the panel is not published
outside the compose network.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `INVINCIBLE_TOKEN` | yes | The gateway token; also accepted by the agent API |
| `PANEL_PASSWORD_HASH` | one of | `scrypt:salt:hash` from `scripts/hash-password.mjs` |
| `PANEL_PASSWORD` | one of | Plain password, hashed in memory at start (less good for compose) |
| `PANEL_SECRET` | yes | At least 32 random characters; reserved for signed session material |
| `GATEWAY_URL` | yes | Invincible base URL, with or without `/v1` |
| `AGENT_URL` | yes | Autobot API base, default `http://127.0.0.1:7792` |
| `PANEL_SECURE_COOKIES` | no | `true` behind TLS; default false |
| `PORT` / `PANEL_BIND` | no | `7800` / `0.0.0.0` in a container |

## Security

- HttpOnly, SameSite=Strict session cookie; `Secure` when configured.
- CSRF token required on every mutating request.
- Login rate limit: ten failures per IP per five minutes.
- Constant-time password check (`scrypt`; `timingSafeEqual`).
- Strict CSP, frame denial, no-referrer, no-sniff, permissions policy, noindex.
- Upstream calls use the token only server-side; no token or provider key reaches the browser.
- The compose service runs read-only with all capabilities dropped and `no-new-privileges`.
- The agent API and panel are on an internal Docker network; only Caddy publishes ports.

## Test

```bash
node --check server.mjs
node --check public/app.js
```

The recorded local smoke test covered: login, dashboard, `/api/overview`, session listing,
CSRF rejection (403), successful logout (200), bad password (401), unauthenticated API (401),
and empty task validation (400).
