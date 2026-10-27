# Netcup worker, Coolify and Tailscale

## Current host

The host is an **existing Netcup server already attached to the Coolify control plane**. GitHub
does not provision the machine. It records the server UUID and deploys services through the
Coolify API once the server has been identified.

Minimum practical target:

| Resource | Target |
|---|---|
| CPU | 16 dedicated vCPU or equivalent sustained performance |
| RAM | 64 GB |
| Disk | 360 GB usable NVMe/SSD |
| Network | 1 Gbps |
| OS | current supported Ubuntu LTS or Debian |
| Swap | 4–8 GB emergency only |

This host: Debian 13 (trixie), x86_64, **16 vCPU, 62.8 GiB RAM, 1 TB disk**. Those values are
recorded in `WORKER_CPU_CORES`, `WORKER_MEMORY_GB` and `WORKER_DISK_GB`, so `RUNNER_LABEL=rust-16`
is accurate. Do not raise the label on a smaller host.

Record the actual values in `WORKER_CPU_CORES`, `WORKER_MEMORY_GB`, `WORKER_DISK_GB` and adjust
`RUNNER_LABEL` accordingly. Do not label a smaller host `rust-16`.

Keep the Coolify control plane isolated from CI workloads. If the Netcup server also runs the
control plane, create separate resource limits or a dedicated VM/container boundary for runners;
CI must never be able to restart the service that manages CI.

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

## Configure the connected host

1. Open the Netcup server in Coolify and copy its server UUID into `COOLIFY_SERVER_UUID`.
2. Record the actual OS, architecture, CPU, RAM and disk in the `infra` environment.
3. Apply firewall rules: public SSH only from admin CIDRs; no public Postgres, Redis, Temporal or
   LiteLLM.
4. Install Tailscale and join using the **worker OAuth client** and `tag:polycore-gateway`.
5. Put Coolify services on a private Docker network.
6. Install the GitHub runner outside Coolify's privileged runner integration, or use an
   unprivileged ephemeral runner container with no host Docker socket.
7. Register the runner in the WCKDai trusted runner group with labels:

```text
self-hosted
linux
x64
rust-16
trusted
```

Use the actual `RUNNER_LABEL` value when the host is not a 16-vCPU class machine.

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

For a 16-vCPU/64-GB host, reserve approximately:

| Service | CPU | RAM |
|---|---:|---:|
| LiteLLM + Redis + Postgres | 2 vCPU | 4–6 GB |
| Temporal + Postgres | 3 vCPU | 8 GB |
| Langfuse | 2 vCPU | 4 GB |
| Runner / agents | remaining | remaining |

Start with two agent writers and one verifier, then raise only after measuring CPU steal, load,
cache-hit rate and queue time. On 32 vCPU/128 GB, start with four writers and two verifiers.

- One Rust compilation/test job at a time unless `sccache` hit rates and CPU headroom prove
  otherwise.
- Full corpus and simulation jobs are queued outside interactive agent runs.
- Keep at least 10% disk free; target caches live in R2, not indefinitely on the VM.
- Alert on CPU steal, load, disk >80%, failed runner jobs, cache errors and LiteLLM budget
  exhaustion.
