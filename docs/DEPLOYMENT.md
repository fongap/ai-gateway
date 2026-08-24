# Deployment

> Breaking change: deployment scripts target the 6.x configuration schema (plain node config variables + `NODE_SECRETS_*` secrets). Re-run install/reconfigure after upgrading; no migration is provided.

## Prerequisites

- Node.js ≥ 20
- A Cloudflare account (Workers Free plan is sufficient)
- Node config JSON files — start from the ready-to-edit examples in [`config/`](../config/) (`tier1-nodes.example.json`, `tier2-nodes.example.json`, `node-secrets.example.json`, `models.example.json`, `policies.example.json`)

## First deploy

```bash
npm ci
sh scripts/install.sh        # Windows: powershell scripts/install.ps1
```

The script walks through:

1. Worker naming (written to `wrangler.jsonc`)
2. `npm ci` + full project verification (`npm run verify`) and a dry-run bundle (`npm run check:deploy`)
3. Cloudflare login check
4. Node config JSON files per tier (tier-1 required, tier-2/3 optional)
5. The credentials file: `{ "node-id": "credential" }`
6. Validation + sharding via the shared planner (`scripts/manage-nodes-config.mjs`)
7. Deploy with plain vars (generated local `wrangler.user.jsonc`, gitignored) then `wrangler secret bulk` for `GATEWAY_ACCESS_KEY` + `NODE_SECRETS_*`
8. Optional online verification of `/version`, `/health`, `/v1/models`

Validation fails early on duplicate IDs, missing/orphan credentials, invalid URLs, forbidden credential fields in node configs, or shard overflow.

## Update code

```bash
sh scripts/update.sh         # git pull + verify + redeploy; remote vars/secrets untouched
```

## Reconfigure nodes

```bash
sh scripts/reconfigure.sh    # Windows: powershell scripts/reconfigure.ps1
```

Re-shards configs into new variable values, writes secrets, deletes stale shards beyond the new plan. Optionally rotates `GATEWAY_ACCESS_KEY`.

## Verify / operate

```bash
npm run verify               # syntax + version + config checks + tests + secret scan
npm run check:deploy         # wrangler dry-run bundle
npm run bench                # gateway overhead benchmark smoke
npx wrangler tail            # live logs
```

## Platform-level protection

The Worker intentionally does not implement its own global rate limiting. For abuse protection use Cloudflare's platform features (current capabilities and free-tier allowances are documented at developers.cloudflare.com):

- **WAF custom rules** — block unwanted origins/paths before they reach the Worker
- **Rate limiting rules** — per-IP or per-header limits on `/v1/*`
- **Security headers / Bot Fight Mode** as appropriate

## CI

`.github/workflows/ci.yml` runs `npm ci`, `npm run verify` and `npm run check:deploy` on push/PR. Tag pushes (`v*.*.*`) build release archives via `.github/workflows/release.yml`.
