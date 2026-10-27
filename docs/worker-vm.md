# Worker VM, Coolify and Tailscale

## Sizing

Recommended initial worker:

| Resource | Target |
|---|---|
| CPU | 16 dedicated vCPU / 8 physical cores with SMT |
| RAM | 64 GB |
| Disk | 360–500 GB NVMe |
| Network | 1 Gbps |
| OS | Ubuntu 24.04 LTS, headless |
| Swap | 4–8 GB emergency only |

Hetzner **AX42** is the best price/performance option when available. **CCX43** is the equivalent
dedicated-cloud choice. Verify current price and availability at order time. Do not use shared
vCPU plans for Rust CI timing tests.

Keep the Coolify control plane on a separate small host. CI must never restart the service that
manages CI.

## Security boundary

These are public repositories. GitHub warns that self-hosted runners can be persistently
compromised by untrusted workflow code.

- Pull requests run on **GitHub-hosted** runners.
- The self-hosted runner is requested only by trusted `main`, merge-queue, nightly or
  maintainer-dispatched jobs.
- Prefer ephemeral runners. If using a persistent runner, use a dedicated VM/user and rotate it
  regularly.
- Do not enable privileged Docker access unless a trusted job requires it.
- Never expose a self-hosted runner to fork pull requests.
- Tailscale and firewall rules allow only Coolify and trusted administrative devices.

## Provision

1. Create the Ubuntu 24.04 VM and an SSH key dedicated to Coolify.
2. Add the server in Coolify and record its server UUID and SSH-key UUID.
3. Apply firewall rules: public SSH only from admin CIDRs; no public Postgres, Redis, Temporal or
   LiteLLM.
4. Install Tailscale and join with a tagged, ephemeral OAuth credential.
5. Put Coolify services on the private Docker network.
6. Install the GitHub runner outside Coolify's privileged runner integration, or use an
   ephemeral runner container with no host Docker socket.
7. Register the runner in the WCKDai trusted runner group with labels:

```text
self-hosted
linux
x64
rust-16
trusted
```

## Coolify services

### LiteLLM

- PostgreSQL + Redis + LiteLLM.
- Store upstream provider keys only in Coolify's encrypted environment.
- Configure aliases and budgets from `services/litellm/config.example.yaml`.
- Expose only over Tailscale.
- Use a stable LiteLLM master key and never rotate the salt key in place.

### Temporal

- PostgreSQL-backed Temporal server and UI.
- Keep visibility storage/retention appropriate for the worker disk.
- Reuse Temporal Cloud instead if operating the cluster becomes more expensive than the saved
  engineering time.

### Langfuse

- Optional but recommended once more than one model/provider is active.
- Store prompts, traces, token/cost metrics and eval outcomes.
- Do not upload private designs or credentials into traces.

### MinIO

Optional local artifact store. R2 remains the shared sccache and cross-runner artifact store.

## Capacity policy

- Four agent writers, two verifiers maximum.
- One Rust compilation/test job at a time unless `sccache` hit rates and CPU headroom prove
  otherwise.
- Full corpus and simulation jobs are queued outside interactive agent runs.
- Keep at least 10% disk free; target caches live in R2, not indefinitely on the VM.
- Alert on CPU steal, load, disk >80%, failed runner jobs, cache errors and LiteLLM budget
  exhaustion.
