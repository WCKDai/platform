# Shared R2 sccache

## Bucket and token

- One private bucket, currently `wckd`.
- Dedicated Cloudflare R2 API token with **Object Read & Write**, scoped to that bucket.
- Never use an account-wide admin token.
- Prefix keys by project: `polycore`, `polykrom`, future projects.
- Add a lifecycle rule for stale objects after 30–90 days if desired.

## GitHub organization configuration

Organization variables and R2 secret access are selected for participating repositories
(currently seven public repositories), separately from the eight-repository alpha runner selection.
A repository can opt out of R2 without losing alpha runner access; use `cache: false` there.
On GitHub Free they are usable only by public repositories; selecting a private repository does
not make organization secrets or variables available there. No credential value is copied or
rotated when changing an organization access policy.

https://github.com/organizations/WCKDai/settings/actions/variables

Required names and example placeholders (not a dump of the live configuration):

```text
R2_CONFIGURED=false  # set true only after verification
R2_BUCKET=SET_ME
R2_ENDPOINT=https://SET_ME.r2.cloudflarestorage.com
SCCACHE_REGION=auto
SCCACHE_S3_USE_SSL=true
```

Organization secrets are managed at:

https://github.com/organizations/WCKDai/settings/actions/secrets

```text
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
```

Never print or export existing secret values. Add missing keys through GitHub settings or a
local `gh secret set` prompt, not chat, workflow output or an artifact.

Repository variables:

```text
SCCACHE_S3_KEY_PREFIX=<repository-name>
```

The gate prevents CI from trying an incomplete configuration. Set `R2_CONFIGURED=true` only after
the secrets are present and one full test job saves/restores cache entries.

### Private repositories on GitHub Free

Each private repository needs **repository-local** `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY` secrets, plus local copies of the five non-secret cache variables above.
The non-secret copies can be provisioned from the existing organization configuration without
reading a secret value. Keep local `R2_CONFIGURED=false` until the owner adds bucket-scoped keys
and authorizes testing; then enable it for the probe. Do not claim caching is active before the
remote write/fresh-server hit succeeds. Do not publish private repository details in this public
runbook. A paid plan upgrade is an owner billing decision, not an automated workaround.

If a participating repository becomes public, verify its organization secret/variable grants
before relying on inheritance. Remove obsolete private fallback variables only when they are
unchanged setup values you own; preserve the repository-specific cache prefix and user edits.

R2 prefixes keep cache keys organized; they are **not** credential-enforced security boundaries.
All trusted repositories sharing a bucket-scoped token can access that bucket. Use separate
bucket-scoped tokens/buckets if stronger isolation is needed.

## Workflow mapping

```yaml
RUSTC_WRAPPER: sccache
SCCACHE_BUCKET: ${{ vars.R2_BUCKET }}
SCCACHE_ENDPOINT: ${{ vars.R2_ENDPOINT }}
SCCACHE_REGION: ${{ vars.SCCACHE_REGION }}
SCCACHE_S3_USE_SSL: ${{ vars.SCCACHE_S3_USE_SSL }}
SCCACHE_S3_KEY_PREFIX: ${{ vars.SCCACHE_S3_KEY_PREFIX }}
AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

## Verification

Prefer dispatching **Alpha and R2** on `main` after its workflow has been
allowed in the trusted runner group. It checks alpha and proves a remote cache write and hit
with fresh server/cache directories. It does not deploy an app or execute repository code.
The workflow is additive; existing PolyCore/Polykrom CI remains unchanged.

The older **Preflight** workflow also probes network/gateway/control-plane services, so do not
dispatch it for a cache-only change without separately approving those targets. Its cache job writes, reads and deletes one
`_preflight/` object with the plain AWS CLI, then starts `sccache` against the same bucket. A
`SignatureDoesNotMatch` response means the secret does not belong to the access key ID; issue a
fresh bucket-scoped token rather than editing the endpoint or region.

Then:

- Run a full CI job twice.
- Confirm sccache health/stats and nonzero cache hits on the second run.
- Confirm R2 object prefixes match the repository.
- Confirm pull-request jobs cannot read the `ci` environment secrets.
- Rotate the token without changing the bucket or prefixes.
