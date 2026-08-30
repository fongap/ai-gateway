# Deployment

## Production deployment: push to `main`

Production is designed so routine code delivery needs only:

```bash
git push origin main
```

Until a Fork owner sets `GATEWAY_CONFIG`, the Deploy job is skipped successfully. This keeps an unconfigured Fork green; after `GATEWAY_CONFIG` is set, missing credentials or invalid configuration fail the deployment explicitly.

The `Deploy` workflow validates fork-specific Worker text-variable configuration and encrypted credentials, synchronizes them to Cloudflare, applies D1 migrations when configured, deploys the Worker, then performs live health checks on `/health`, `/v1/models`, and Anthropic `/v1/messages/count_tokens`. Any failed check fails the workflow.

Cloudflare Dashboard configuration is **not** a deployment source. The workflow deploys with `keep_vars: false`, so a stale Dashboard text variable cannot survive a successful push and turn a healthy release into `configuration_status: invalid`.

### One-time GitHub setup

Create this GitHub repository Secret:

| Secret | Required | Purpose |
|---|---:|---|
| `CLOUDFLARE_API_TOKEN` | yes | Permission to deploy the Worker, update Worker Secrets, and run D1 migrations |
| `GATEWAY_SECRETS_CONFIG` | yes | Gateway access key and upstream credentials only |

Create these non-secret GitHub repository variables:

| Variable | Required | Purpose |
|---|---:|---|
| `CLOUDFLARE_ACCOUNT_ID` | yes | Cloudflare account selected by Wrangler |
| `TOKEN_STATS_D1_ID` | no | D1 database ID; enables migrations and homepage usage persistence |
| `GATEWAY_CONFIG` | yes | Non-sensitive Worker text variables: nodes, model mapping, policies, and runtime parameters |
| `GATEWAY_PUBLIC_BASE_URL` | yes | Public gateway origin used only for post-deploy health checks; do not append `/v1` |

### Worker text-variable configuration

Copy [`config/worker-vars.example.json`](../config/worker-vars.example.json), replace the example node and model values, then paste the whole JSON object into the GitHub repository Variable `GATEWAY_CONFIG`. It contains only non-sensitive configuration: node IDs, provider URLs, model mapping, policies, and runtime parameters. Do not commit a Fork-specific configuration file.

```bash
cp config/worker-vars.example.json gateway-config.json
# edit gateway-config.json locally, then paste it into GitHub Variable GATEWAY_CONFIG
```

### Worker Secret configuration

Copy [`config/gateway-secrets.example.json`](../config/gateway-secrets.example.json), replace every placeholder, and store the resulting JSON in the encrypted GitHub repository Secret `GATEWAY_SECRETS_CONFIG`. Do not commit this file.

```bash
cp config/gateway-secrets.example.json gateway-secrets.json
# edit gateway-secrets.json locally; do not commit it
gh secret set GATEWAY_SECRETS_CONFIG < gateway-secrets.json
```

The Secret is a flat JSON object containing credentials only:

```json
{
  "GATEWAY_ACCESS_KEY": "client-access-key",
  "NODE_SECRETS_01": { "primary-01": "upstream-credential" }
}
```

`GATEWAY_CONFIG` accepts JSON arrays/objects, strings, numbers, or booleans; the workflow serializes each value to a Worker environment string. `GATEWAY_SECRETS_CONFIG` accepts only `GATEWAY_ACCESS_KEY` and `NODE_SECRETS_01..99`. Every Worker configuration value is validated against the 4.5 KB shard limit, and the same configuration loader used at runtime must report `ready` before the workflow changes Cloudflare.

After this one-time setup, push normally. The repository has no credential file to commit, and no Cloudflare Dashboard reconfiguration is needed after a code push.

### Changing runtime configuration

Update GitHub Variable `GATEWAY_CONFIG` for non-sensitive changes (nodes, model mapping, policies, runtime parameters). Update `GATEWAY_SECRETS_CONFIG` only when rotating the gateway access key or an upstream credential. Then use **Run workflow** in GitHub Actions to apply the configuration change, or let the next `main` push apply it. The deployment replaces Worker text variables and updates managed Worker Secrets automatically; obsolete `NODE_SECRETS_XX` shards are deleted in the same bulk operation. Do not edit these managed values in the Cloudflare Dashboard.

## Local development and manual recovery

For local development or an emergency/manual install, use the existing operator scripts:

```bash
npm ci
sh scripts/install.sh        # Windows: powershell scripts/install.ps1
```

They generate a gitignored `wrangler.user.jsonc`, shard node configuration, and upload Worker Secrets. This path is useful for bootstrapping, but it is not the production configuration source once GitHub Actions deployment is enabled.

```bash
sh scripts/reconfigure.sh    # Windows: powershell scripts/reconfigure.ps1
```

Use reconfigure only to recover or bootstrap a local/operator deployment. A subsequent GitHub deployment replaces its Worker text variables from GitHub Variable `GATEWAY_CONFIG`.

## Verification and operations

```bash
npm run verify               # syntax + version + config checks + tests + secret scan
npm run check:deploy         # local Wrangler dry-run using local operator config
npm run bench                # gateway overhead benchmark smoke
npx wrangler tail            # live logs
```

The authenticated `/health` response contains `diagnostics` when configuration is invalid. In production, the workflow validates that same configuration before deployment and checks the live endpoint afterward, so a generic Claude 500 response should be treated as a failed workflow/configuration incident, not as a Claude protocol problem.

## Platform-level protection

The Worker intentionally does not implement its own global rate limiting. For abuse protection use Cloudflare's platform features:

- **WAF custom rules** — block unwanted origins/paths before they reach the Worker.
- **Rate limiting rules** — per-IP or per-header limits on `/v1/*`; also protect unauthenticated `GET /`.
- **Security headers / Bot Fight Mode** as appropriate.

## CI behaviour

`.github/workflows/ci.yml` verifies every push and pull request. `.github/workflows/deploy.yml` runs independently on non-documentation pushes to `main`; it repeats the full verification before it changes D1, Worker Secrets, or the Worker. Tag pushes (`v*.*.*`) build release archives through `.github/workflows/release.yml`.
