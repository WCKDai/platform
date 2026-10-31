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
- Register this host with `RUNNER_NAME=alpha`; the shared workflow checks that exact runner name.
  The installer's generic hostname default is not sufficient on a differently named host.
- Runner group `trusted`, selected for the eight current organization repositories.
  New repositories require explicit approval; this is not an organization-wide wildcard.
- Labels: `self-hosted`, `linux`, `x64`, `rust-16`, `trusted`.
- Keep Rust toolchains, sccache, Docker and helper CLIs updated by a scheduled maintenance job.
- No long-lived provider keys on disk. Environment-scoped values are injected per job.

Order matters. A runner group that permits public repositories will run workflow code from any
workflow the group allows, including a fork pull request. So:

1. Merge the workflow that requests the runner into `main`.
2. Keep `allows_public_repositories=true` and `restricted_to_workflows=true` on the `trusted`
   group. Preserve the existing PolyCore/Polykrom main workflow entries. After the shared workflow
   is merged, add `WCKDai/platform/.github/workflows/alpha-r2.yml@refs/heads/main` and its reviewed
   commit SHA. GitHub rejects entries for workflows that do not exist at the selected ref.
3. Only then register the runner.

For an initial bootstrap, establish the workflow restrictions before enabling public access or
registering a runner. Alpha is already registered; do not rerun the installer for workflow-only
changes.

## Shared trusted builds

The additive `alpha-r2.yml` reusable workflow provides a trusted build entry point without
migrating lightweight Python/JavaScript jobs or weakening existing PR gates. Call it only from
`main` on `push`, `schedule`, or a reviewed caller's manual trigger. PRs and forks must stay
GitHub-hosted. Direct manual dispatch of the shared workflow runs fixed probes only; it has no
command input and cannot turn repository write access into an unreviewed shell on alpha.
Pin the reviewed shared-workflow commit SHA, and ensure that exact SHA is included in the
runner-group workflow allowlist before using it. Merely granting repository access is not proof
that a job can run: the workflow allowlist is a second independent gate.

```yaml
permissions:
  contents: read
jobs:
  native:
    uses: WCKDai/platform/.github/workflows/alpha-r2.yml@<REVIEWED_40_HEX_SHA>
    with:
      cache: true
      command: cargo xtask ci
    secrets:
      R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
      R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

`command` is deliberately executable **trusted main-branch code**. This is not a sandbox for
untrusted inputs. There is no arbitrary checkout-ref input: checkout is the caller's immutable
`github.sha`, without persisted credentials. Only reusable callers may supply `command`; use a
fixed command in reviewed workflow code, not an unrestricted dispatch/issue input. An empty
reusable command, or direct manual dispatch, means infrastructure probes only.
Use `cache: false` for jobs that do not compile native code; that run does not verify R2.
Rust uses `RUSTC_WRAPPER`; C/C++ callers can explicitly invoke `sccache gcc` or `sccache clang`.
Builds use four jobs/threads, `nice`, a 10 GiB disk floor and the existing load ceiling of 24.
Only one Actions job runs on the single alpha runner at a time; do not start competing SSH builds.

The workflow installs checksum-pinned sccache under the job temp directory, not globally. Its
probe uses a unique port and fresh cache directories and stops only its own server, so it does
not hijack another build's daemon or repository prefix. Both a remote write and a hit from a
fresh server are required; a local fallback, missing key or cache error is not a pass.

## Queueing and cost

- Run `cargo nextest` archives and shards; build once.
- Use sccache R2 plus a small local cache.
- Keep PR gate under 15 minutes and merge/full gate under 60 minutes.
- Re-run only failed jobs caused by infrastructure; never rerun an unchanged real failure.
- Track runner-minutes per merged change, queue wait, cache hit rate and disk/CPU pressure.
