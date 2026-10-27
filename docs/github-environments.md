# GitHub control environments

GitHub supports environments only at repository scope. Organization secrets/variables can be
shared, but environment protection, reviewers and environment-specific secrets belong to a
repository. `WCKDai/platform` is therefore the central environment store.

All sensitive placeholders are currently `SET_ME`, and `INFRA_CONFIGURED=false`. Replace them in
the environment UI; never put a credential in a variable.

## `infra`

https://github.com/WCKDai/platform/settings/environments/infra

Protected to the `main` branch.

| Variable | Set to |
|---|---|
| `COOLIFY_URL` | Coolify HTTPS URL, no trailing slash |
| `COOLIFY_API_TOKEN` secret | Coolify API token with least privilege |
| `COOLIFY_SERVER_UUID` | UUID of the worker server in Coolify |
| `COOLIFY_PRIVATE_KEY_UUID` | UUID of the Coolify SSH key used for that server |
| `COOLIFY_PROJECT_NAME` | `PolyCore` |
| `COOLIFY_ENVIRONMENT_NAME` | `production` |
| `HETZNER_LOCATION` | `fsn1` or chosen region |
| `WORKER_NAME` | `polycore-worker` |
| `WORKER_TYPE` | `ccx43`, `ax42`, or selected plan |
| `WORKER_IMAGE` | `ubuntu-24.04` |
| `HCLOUD_TOKEN` secret | Hetzner Cloud API token if provisioning cloud VMs |
| `HETZNER_ROBOT_PASSWORD` secret | Only if provisioning a Hetzner dedicated server |
| `RUNNER_ADMIN_TOKEN` secret | Short-lived fine-grained token/app token for org runner registration |

## `network`

https://github.com/WCKDai/platform/settings/environments/network

Protected to the `main` branch.

| Variable | Set to |
|---|---|
| `TAILSCALE_TAILNET` | e.g. `tailxxxx.ts.net` |
| `TAILSCALE_HOSTNAME` | `polycore-worker` |
| `TAILSCALE_TAGS` | `tag:polycore-ci,tag:polycore-gateway` |
| `TAILSCALE_OAUTH_CLIENT_ID` | Tailscale OAuth client ID |
| `TAILSCALE_OAUTH_CLIENT_SECRET` secret | OAuth client secret |
| `TAILSCALE_AUTH_KEY` secret | Optional one-time key fallback; prefer OAuth |

Recommended Tailscale policy:

- tag the worker `tag:polycore-gateway`;
- allow only WCKDai owners/devices and the trusted runner to reach LiteLLM/Temporal;
- expose no LiteLLM, Temporal, Postgres or Redis port publicly;
- use an ephemeral/tagged OAuth key for runner registration.

## `agents`

https://github.com/WCKDai/platform/settings/environments/agents

| Variable | Default |
|---|---|
| `AGENT_MONTHLY_USD_BUDGET` | `100` |
| `AGENT_MAX_CONCURRENT` | `2` locally; raise on dedicated worker |
| `AGENT_MODEL_CHEAP` | `deepseek-flash` |
| `AGENT_MODEL_STANDARD` | `claude-sonnet-5-5` |
| `AGENT_MODEL_STRONG` | `claude-opus-5-5` |
| `AGENT_MODEL_REVIEW` | `gpt-6.1-sol` |

Secrets:

```text
ANTHROPIC_API_KEY
OPENAI_API_KEY
GEMINI_API_KEY
DEEPSEEK_API_KEY
LITELLM_MASTER_KEY
LITELLM_SALT_KEY
TEMPORAL_API_KEY
```

Generate LiteLLM's master and salt keys rather than copying them from a provider:

```sh
openssl rand -hex 32
openssl rand -hex 32
```

Keep `LITELLM_SALT_KEY` stable after LiteLLM has stored credentials; changing it makes stored
model credentials unreadable.

## Shared R2

The R2 variables/secrets now exist at organization level, selected only for PolyCore, Polykrom
and platform. R2 credentials are low privilege and cache-only; model provider keys are not placed
in GitHub organization secrets. Replace the placeholders and set `R2_CONFIGURED=true` after
verification. See [cache.md](cache.md).

See [cache.md](cache.md).
