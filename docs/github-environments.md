# GitHub control environments

GitHub supports environments only at repository scope. Organization secrets/variables can be
shared, but environment protection, reviewers and environment-specific secrets belong to a
repository. `WCKDai/platform` is therefore the central environment store.

Sensitive placeholders are `SET_ME`. Gates are `INFRA_CONFIGURED=false`,
`NETWORK_CONFIGURED=false` and `AGENTS_CONFIGURED=false`. Replace values in the environment UI;
never put a credential in a variable.

## `infra`

https://github.com/WCKDai/platform/settings/environments/infra

Protected to the `main` branch.

| Variable | Set to |
|---|---|
| `INFRA_PROVIDER` | `netcup` |
| `COOLIFY_URL` | Existing Coolify HTTPS URL, no trailing slash |
| `COOLIFY_API_TOKEN` secret | Coolify API token with least privilege |
| `COOLIFY_SERVER_UUID` | UUID of the Netcup server in Coolify |
| `COOLIFY_PROJECT_NAME` | `PolyCore` |
| `COOLIFY_ENVIRONMENT_NAME` | `production` |
| `WORKER_NAME` | Coolify server name, e.g. `polycore-worker` |
| `WORKER_ARCH` | `x64` unless the server is ARM |
| `WORKER_OS` | exact OS, e.g. `ubuntu-24.04` |
| `WORKER_CPU_CORES` | actual allocated vCPU count |
| `WORKER_MEMORY_GB` | actual RAM in GiB |
| `WORKER_DISK_GB` | usable NVMe/SSD capacity |
| `RUNNER_LABEL` | `rust-16`, adjusted to actual capacity |
| `RUNNER_ADMIN_TOKEN` secret | Short-lived fine-grained token/app token for org runner registration |

The server is already connected to Coolify. No cloud-provider provisioning token or SSH-key UUID
is required.

## `network`

https://github.com/WCKDai/platform/settings/environments/network

Protected to the `main` branch.

| Variable | Set to |
|---|---|
| `TAILSCALE_TAILNET` | e.g. `tailxxxx.ts.net` |
| `TAILSCALE_WORKER_CLIENT_ID` | Persistent worker OAuth client ID |
| `TAILSCALE_WORKER_CLIENT_SECRET` secret | Persistent worker OAuth secret |
| `TAILSCALE_WORKER_TAGS` | `tag:polycore-gateway` |
| `TAILSCALE_WORKER_HOSTNAME` | `polycore-worker` |
| `TAILSCALE_CI_CLIENT_ID` | Ephemeral CI OAuth client ID |
| `TAILSCALE_CI_CLIENT_SECRET` secret | Ephemeral CI OAuth secret |
| `TAILSCALE_CI_TAGS` | `tag:polycore-ci` |

Use `${secret}` names in automation. See [tailscale.md](tailscale.md) for the two-client scopes,
ACL and rotation policy.

- Tag the worker `tag:polycore-gateway`.
- CI nodes are ephemeral and tagged `tag:polycore-ci`.
- Allow only WCKDai admins/devices and the trusted runner to reach LiteLLM/Temporal.
- Expose no LiteLLM, Temporal, Postgres or Redis port publicly.

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

## Preflight

[`.github/workflows/preflight.yml`](../.github/workflows/preflight.yml) is a manual,
read-only diagnostic. Each job runs only when its gate is `true`:

| Job | Gate | Checks |
|---|---|---|
| `cache` | `R2_CONFIGURED` | AWS CLI read/write/delete, then an `sccache` store open |
| `network` | `NETWORK_CONFIGURED` | CI OAuth client joins, tailnet and `tag:polycore-ci` |
| `infra` | `INFRA_CONFIGURED` | Coolify token, version endpoint and server UUID |

Run it from **Actions → Preflight → Run workflow** after changing any of those values. The
`infra` and `network` jobs use the protected environments, so they only run from `main`.
