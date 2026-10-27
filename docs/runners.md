# GitHub runners

## Trust model

| Event | Runner |
|---|---|
| `pull_request` from any branch/fork | GitHub-hosted |
| Trusted same-repo smoke that needs custom hardware | Require label/approval; prefer hosted |
| `push` to `main` | Trusted self-hosted `rust-16` |
| Merge queue | Trusted self-hosted `rust-16` |
| Nightly full corpus/determinism | Trusted self-hosted `rust-16` |
| macOS/OCCT | Existing Apple Silicon, trusted |
| GPU/Omniverse/CFD | Dedicated labelled GPU runner, nightly/manual |

Runner labels are not security boundaries. Repository access, environment branch policies and
workflow triggers are.

## Mac

Use the existing Mac for:

- local OpenCode agents, at most two writers and one verifier;
- macOS builds;
- OCCT/bake-off;
- Metal/GPU smoke.

Use a separate runner user and avoid exposing personal credentials to jobs. Prefer a dedicated
ephemeral macOS VM (Tart or equivalent) for untrusted code.

## Linux worker

Current host: Netcup, Debian 13 (trixie), x86_64, 16 vCPU, 62.8 GiB RAM, 1 TB disk,
already attached to the Coolify control plane.

- Official GitHub runner as a systemd service, registered once with a one-hour token:
  [`scripts/install-runner.sh`](../scripts/install-runner.sh).
- Runner group `trusted`, limited to `WCKDai/polycore` and `WCKDai/polykrom`.
- Labels: `self-hosted`, `linux`, `x64`, `rust-16`, `trusted`.
- Keep Rust toolchains, sccache, Docker and helper CLIs updated by a scheduled maintenance job.
- No long-lived provider keys on disk. Environment-scoped values are injected per job.

Order matters. A runner group that permits public repositories will run workflow code from any
workflow the group allows, including a fork pull request. So:

1. Merge the workflow that requests the runner into `main`.
2. Set `allows_public_repositories=true` and `restricted_to_workflows=true` on the `trusted`
   group, listing only `WCKDai/polycore/.github/workflows/ci.yml@refs/heads/main`.
3. Only then register the runner.

Until step 3 the group stays `allows_public_repositories=false` and no runner exists, so nothing
can reach the host.

## Queueing and cost

- Run `cargo nextest` archives and shards; build once.
- Use sccache R2 plus a small local cache.
- Keep PR gate under 15 minutes and merge/full gate under 60 minutes.
- Re-run only failed jobs caused by infrastructure; never rerun an unchanged real failure.
- Track runner-minutes per merged change, queue wait, cache hit rate and disk/CPU pressure.
