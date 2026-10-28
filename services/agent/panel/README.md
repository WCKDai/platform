# Invincible control panel

One authenticated surface for an Invincible gateway and an Autobot agent. It is a small Node
process with no runtime dependencies and no build step.

- **Overview:** gateway models and node identity, the agent's tasks and conversations, today's
  tokens and cost, and the approvals waiting.
- **Chat:** a conversation transcript, a live turn, and a new conversation. The versioned stream
  (`spec/agent.md`, Turn events) gives text and reasoning deltas, tool starts and outputs, diffs,
  approval cards, receipts and the final answer; the session id comes back in `X-Session-Id`.
- **Workspaces:** start a thread (a git worktree and branch from the bot's project), put it in
  Chat with **Use**, read its **Diff**, open a **PR**, or remove it. A removed thread leaves a
  tombstone so its old session cannot silently use the main checkout.
- **Bots:** list, add, enable, disable and reload bots.
- **Integrations:** the channel matrix for every bot, write-only token files (`mode 0600`) in the
  bot's home, and the configured MCP servers.
- **Usage:** today's turns, calls, tokens and cost; models, tools and failures; the gateway audit.
- **Settings:** the models the gateway serves (keys stay in the gateway), this bot's model,
  approvals, tool groups, the workdir/sandbox and any advanced dotted configuration key.

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
- `app.css` and `app.js` are the only static assets and are served without a session (the login
  page needs the stylesheet); neither contains a secret. Everything else requires the cookie.

## Test

```bash
node --check server.mjs
node --check public/app.js
```

The recorded local smoke test covered: login, dashboard, `/api/overview`, session listing,
CSRF rejection (403), successful logout (200), bad password (401), unauthenticated API (401),
and empty task validation (400). The control-plane test additionally covered settings
(`agent.max_steps`), tool groups, model selection, a write-only token file (`0600`), adding a bot,
creating a thread, a task writing inside the worktree, its diff, its push to a local remote, and
removing it; Playwright drove the same thread flow through the panel.
