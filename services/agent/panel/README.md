# Invincible control panel

One authenticated surface for an Invincible gateway and an Autobot agent. It is a small Node
process with no runtime dependencies and no build step.

The shell is a persistent sidebar and a page header. **Operate** is Overview, Chat, Mission,
Workspaces, Delegations, Botmode, Studio and GPU. **Configure** is Project, Providers, Secrets,
Variables, Subscriptions and Integrations. **Observe** is Usage. **System** is Settings. `⌘K`
opens a command palette. On a narrow screen the same tree opens in a drawer.

Controls come from [Web Awesome](https://webawesome.com) 3.14.0, the MIT-licensed successor to
Shoelace (`@awesome.me/webawesome`). The files under `public/vendor/webawesome/` are a pinned
subset (the components this panel imports, their chunks, and the dark theme CSS), about 730 KiB,
served by the panel. There is no CDN and no build. The code license is MIT (Fonticons, Inc.);
see `public/vendor/webawesome/LICENSE.md`. Icons inside those components are the inlined
"system" set, Font Awesome Free, CC BY 4.0. Two local patches, noted in `NOTICE.txt`, stop the
default icon library from calling Font Awesome's CDN and decode `data:` icons without a `fetch`,
so `connect-src` stays `'self'`. The panel themes Web Awesome with its own tokens: ink
background, hairline rules, and WCKD purple (`#7C5CFF`, readable lilac `#9373FF` on buttons).

- **Overview:** gateway and agent health, tasks, today's tokens and cost, the monthly subscription
  total and next renewal, approvals, recent conversations.
- **Chat:** a conversation rail with search, a transcript search, and a composer. Enter sends,
  Shift+Enter inserts a line. Image attachments go with the turn (up to four `data:image` URLs);
  text files are folded into the message. **Keep going** runs a delegated turn. The stream gives
  text and reasoning, tool starts and outputs, diffs, approval cards, receipts and the final
  answer. The session id comes back in `X-Session-Id`. A bot chosen in the composer is sent as
  `bot` on a new conversation.
- **Mission:** one view of the project brief, the conversation plan, the team board
  (`/v1/agent/board`), the worktrees and the delegated runs for the selected thread.
- **Workspaces:** start a thread (a git worktree and branch from the bot's project), put it in
  Chat with **Use**, read its **Diff**, open a **PR**, or remove it. A removed thread leaves a
  tombstone so its old session cannot silently use the main checkout.
- **Botmode:** each bot's status, model, channels, and what it is working on (a running or paused
  delegation, or a board task). Enable, disable, reload, or **Talk**, which opens Chat aimed at
  that bot.
- **Studio:** image jobs go to the gateway `POST /v1/images/generations` (`[[images]]`). Audio
  jobs go to `POST /v1/audio/speech` (`[[speech]]`). Video jobs go to a rented ComfyUI session
  (preset `comfyui-minimax-h3`). The queue shows progress. Finished files are played from the
  panel; the browser never receives a provider key or a pod URL. If a backend is missing, the job
  says so.
- **GPU:** proxies the gateway's `/v1/rent/*` (offers, create, list, get, stop, health). Regions
  are EU or EU-secure only. Create is sent with `confirm: false` first. The gateway's 409 estimate
  is shown (offer, $/hr, hours, estimated total) and nothing is rented until **Rent this offer**
  sends `confirm: true` and `X-Wckd-Confirm: true`. A live session shows the countdown, cost so
  far and Stop. If the gateway has no rent route, the room says "GPU rental not connected on this
  node".
- **Agents:** the add-agent form lives on Botmode.
- **Providers:** the models the gateway serves and this agent's model, plus every external coding
  CLI detected on the machine (`codex`, `claude`, `opencode`, `cursor-agent`, `hermes`, `pi`) with
  version, path, auth kind and login hint. Provider keys stay in the gateway; the page shows the
  node-side command for adding one and never sends a key through the browser.
- **Secrets:** the secret files in the agent's home with kind, size and update time; add or rotate
  one (write-only, mode 0600) or remove one. Values are never returned.
- **Variables:** non-secret context added to every turn (`project.name`, `deploy.host`, …), with
  key, value, description and update time. They are data in the system prompt, not instructions.
- **Subscriptions:** a ledger of plans, providers, status, monthly cost and currency, renewal date
  and seats, with totals per currency and the next 30 days' renewals.
- **Integrations:** the channel matrix for every agent, the configured MCP servers, and incoming
  webhook guidance. Tokens are managed on **Secrets**.
- **Usage:** today's turns, calls, tokens and cost; models, tools and failures; the gateway audit.
- **Settings:** this agent's model, approvals, tool groups, the workdir/sandbox, the configured
  verification check and any advanced dotted configuration key.

The panel holds one Invincible API token, and only the server side uses it. The browser sees the
panel's own session cookie and a CSRF token. Assets carry a content hash, so a deploy is visible
immediately through the CDN.

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
- `app.css`, `app.js`, `vendor/panel-kit.js` and `vendor/webawesome/` are the static assets.
  They are served without a session (the login page needs the stylesheet and the components) and
  contain no secret. Content-hashed chunks are cached as immutable. Everything else requires the
  cookie.

## Test

```bash
npm test
```

`npm test` starts stand-in gateway and agent processes and checks login, CSRF, every room in the
HTML, EU-only rental confirmation (including that a 409 estimate is not upgraded to a create),
secret scrubbing, and image, speech and video jobs.

The recorded local smoke test covered: login, dashboard, `/api/overview`, session listing,
CSRF rejection (403), successful logout (200), bad password (401), unauthenticated API (401),
and empty task validation (400). The control-plane test additionally covered settings
(`agent.max_steps`), tool groups, model selection, a write-only token file (`0600`), adding a bot,
creating a thread, a task writing inside the worktree, its diff, its push to a local remote, and
removing it; Playwright drove the same thread flow through the panel.
