# Shared R2 sccache

## Bucket and token

- One private bucket, e.g. `wckdboy-sccache`.
- Dedicated Cloudflare R2 API token with **Object Read & Write**, scoped to that bucket.
- Never use an account-wide admin token.
- Prefix keys by project: `polycore`, `polykrom`, future projects.
- Add a lifecycle rule for stale objects after 30–90 days if desired.

## GitHub organization configuration

After `gh auth refresh -h github.com -s admin:org`, set organization variables selected for
PolyCore, Polykrom and platform:

```text
R2_CONFIGURED=false  # set true only after verification
R2_BUCKET=SET_ME
R2_ENDPOINT=https://SET_ME.r2.cloudflarestorage.com
SCCACHE_REGION=auto
SCCACHE_S3_USE_SSL=true
```

Organization secrets:

```text
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
```

Repository variable:

```text
PolyCore: SCCACHE_S3_KEY_PREFIX=polycore
Polykrom: SCCACHE_S3_KEY_PREFIX=polykrom
```

The gate prevents CI from trying an incomplete configuration. Set `R2_CONFIGURED=true` only after
the secrets are present and one full test job saves/restores cache entries.

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

- Run a full CI job twice.
- Confirm sccache health/stats and nonzero cache hits on the second run.
- Confirm R2 object prefixes match the repository.
- Confirm pull-request jobs cannot read the `ci` environment secrets.
- Rotate the token without changing the bucket or prefixes.
