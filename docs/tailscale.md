# Tailscale clients and access

Two OAuth clients keep the persistent worker separate from ephemeral CI nodes.

## 1. Worker client

Use for the Coolify worker and any long-lived engineering services.

- Name: `polycore-worker`
- Scopes:
  - `auth_keys` — required to mint tagged worker credentials
  - `devices:core` — optional; enable only if automation must inspect, authorize or remove devices
- Tag: `tag:polycore-gateway`
- Expiry: 90 days, or 180 days with a rotation reminder

GitHub `network` environment:

```text
Variable: TAILSCALE_WORKER_CLIENT_ID
Secret:   TAILSCALE_WORKER_CLIENT_SECRET
Variable: TAILSCALE_WORKER_TAGS=tag:polycore-gateway
Variable: TAILSCALE_WORKER_HOSTNAME=polycore-worker
```

The worker is a normal persistent node. Prefer a tagged, pre-authorized auth key derived from
this client. Tagged devices have key expiry disabled by default; review that setting explicitly.

## 2. CI client

Use only for ephemeral GitHub Actions/agent workers.

- Name: `polycore-ci`
- Scope: `auth_keys`
- Tag: `tag:polycore-ci`
- Expiry: 90 days
- Do not grant `devices:core`, policy, DNS or user-management scopes

GitHub `network` environment:

```text
Variable: TAILSCALE_CI_CLIENT_ID
Secret:   TAILSCALE_CI_CLIENT_SECRET
Variable: TAILSCALE_CI_TAGS=tag:polycore-ci
```

Use it with `tailscale/github-action` or an equivalent runner bootstrap that creates an
**ephemeral, pre-authorized, tagged** node and logs out at job end.

## Tailnet

```text
Variable: TAILSCALE_TAILNET=your-tailnet.ts.net
Gate:     NETWORK_CONFIGURED=true only after both clients are entered
```

## ACL tag owners

Add before creating the clients:

```json
{
  "tagOwners": {
    "tag:polycore-gateway": ["autogroup:admin"],
    "tag:polycore-ci": ["autogroup:admin"]
  }
}
```

Minimal private access policy:

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["autogroup:admin"],
      "dst": ["tag:polycore-gateway:*"]
    },
    {
      "action": "accept",
      "src": ["tag:polycore-ci", "tag:polycore-gateway"],
      "dst": [
        "tag:polycore-gateway:4000",
        "tag:polycore-gateway:3000",
        "tag:polycore-gateway:5432",
        "tag:polycore-gateway:6379",
        "tag:polycore-gateway:7233"
      ]
    }
  ]
}
```

Narrow the ports as services become final. Do not expose LiteLLM, Temporal, Postgres or Redis to
the public internet.

## Rotation

- Rotate one client at a time.
- Replace only its GitHub secret, then restart/re-auth the consumers using that client.
- Revoke the old client after health checks.
- Do not rotate the worker and CI clients together; keep a working fallback.
