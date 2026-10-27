# WCKDai platform

Private control plane for PolyCore, Polykrom and future WCKDai engineering projects.

**No real credential belongs in this repository.** Provider/R2/server credentials live in GitHub
environments, Coolify secrets, or the LiteLLM gateway host. This repository stores the desired
non-secret configuration, deployment manifests and runbooks.

## Projects

| Project | Repository | Cache prefix | Runner label |
|---|---|---|---|
| PolyCore | [WCKDai/polycore](https://github.com/WCKDai/polycore) | `polycore` | `rust-16` |
| Polykrom | [WCKDai/polykrom](https://github.com/WCKDai/polykrom) | `polykrom` | `rust-16` |

## Control environments

GitHub does not provide organization-wide deployment environments. These protected environments
live here because this is the central infrastructure repository:

| Environment | Purpose | Access |
|---|---|---|
| [`infra`](https://github.com/WCKDai/platform/settings/environments/infra) | Coolify API, Hetzner provisioning, runner registration | `main` only |
| [`network`](https://github.com/WCKDai/platform/settings/environments/network) | Tailscale OAuth/auth keys and tailnet settings | `main` only |
| [`agents`](https://github.com/WCKDai/platform/settings/environments/agents) | LiteLLM/provider keys, model routing, budgets | trusted workflows |

Each environment has a safety gate: `INFRA_CONFIGURED=false`, `NETWORK_CONFIGURED=false` or
`AGENTS_CONFIGURED=false`. Automation must not attempt to use real infrastructure until the
required values are replaced and the matching gate is explicitly set to `true`.

See [GitHub environments](docs/github-environments.md) for every variable and secret name.

## One-place configuration

- Non-secret desired state: [`config/platform.yaml`](config/platform.yaml)
- LiteLLM gateway: [`services/litellm`](services/litellm)
- Worker VM and Coolify: [worker VM runbook](docs/worker-vm.md)
- Tailscale clients and ACL: [Tailscale setup](docs/tailscale.md)
- Runners: [runner policy](docs/runners.md)
- Shared R2 sccache: [cache configuration](docs/cache.md)
- PolyCore task policy: [task schema](https://github.com/WCKDai/polycore/blob/main/agent/task.schema.json)

## Architecture

```text
GitHub WCKDai
  issues/PRs/merge queue + environment secrets
        │
        ├── GitHub-hosted Linux: untrusted pull-request checks
        ├── trusted self-hosted Linux runner: main/merge/nightly/agents
        └── existing Apple Silicon Mac: macOS and OCCT checks
                    │
             Tailscale private network
                    │
        Coolify-managed worker VM
          LiteLLM + Postgres + Redis
          Temporal + Postgres
          Langfuse / optional MinIO
                    │
                Cloudflare R2
             content-addressed sccache
```

## Immediate setup checklist

1. ✅ Organizations, repositories, control environments and organization R2/agent slots exist.
2. Replace the `SET_ME` variables in `infra` and `network`.
3. Replace the placeholder secrets in `infra`, `network` and `agents` through the environment settings.
4. Create one private R2 cache bucket and a bucket-scoped read/write token.
5. Replace the organization R2 placeholders and set `R2_CONFIGURED=true` after verification.
6. Add the worker VM to Coolify and Tailscale.
7. Register a trusted org runner labelled `rust-16`.
8. Deploy LiteLLM, Temporal, and observability through Coolify.
9. Run one end-to-end agent task through implementation, tests, review and merge queue.
