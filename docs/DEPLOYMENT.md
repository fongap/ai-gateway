# Deployment

## Production deployment: push to `main`

Production is designed so routine code delivery needs only:

```bash
git push origin main
```

The `Deploy` workflow validates the project and the encrypted runtime configuration package, synchronizes Worker text variables and Worker Secrets, applies D1 migrations when configured, deploys the Worker, then performs live health checks on `/health`, `/v1/models`, and Anthropic `/v1/messages/count_tokens`. Any failed check fails the workflow.

Cloudflare Dashboard configuration is **not** a deployment source. The workflow deploys with `keep_vars: false`, so a stale Dashboard text variable cannot survive a successful push and turn a healthy release into `configuration_status: invalid`.

### One-time GitHub setup

Create these GitHub repository secrets:

| Secret | Required | Purpose |
|---|---:|---|
| `CLOUDFLARE_API_TOKEN` | yes | Permission to deploy the Worker, update Worker Secrets, and run D1 migrations |
| `CLOUDFLARE_ACCOUNT_ID` | yes | Cloudflare account selected by Wrangler |
| `GATEWAY_RUNTIME_CONFIG` | yes | Encrypted runtime configuration package: Worker text variables plus gateway/upstream credentials |
| `TOKEN_STATS_D1_ID` | no | D1 database id; enables migrations and homepage usage persistence |

Create the non-secret GitHub repository variable `GATEWAY_PUBLIC_BASE_URL`, for example `https://ai-gateway.example.workers.dev`. Its value must be the origin only — do **not** append `/v1`.

Start from [`config/github-runtime.example.json`](../config/github-runtime.example.json), replace every placeholder, and store the resulting JSON in the encrypted GitHub repository Secret `GATEWAY_RUNTIME_CONFIG`. For example, with the GitHub CLI:

```bash
cp config/github-runtime.example.json gateway-runtime.json
# edit gateway-runtime.json locally; do not commit it
gh secret set GATEWAY_RUNTIME_CONFIG < gateway-runtime.json
```

The package has exactly two top-level objects:

```json
{
  "vars": {
    "TIER1_NODES_CONFIG_01": [{ "id": "primary-01", "base_url": "https://provider.example.com/v1" }],
    "MODELS_CONFIG": { "code-pro": { "policy": "default" } },
    "POLICIES_CONFIG": { "default": { "max_attempts": 5 } }
  },
  "secrets": {
    "GATEWAY_ACCESS_KEY": "client-access-key",
    "NODE_SECRETS_01": { "primary-01": "upstream-credential" }
  }
}
```

`vars` contains Worker text variables and accepts JSON arrays/objects, strings, numbers, or booleans; the workflow serializes each value to a Worker environment string. `secrets` contains Worker Secrets and accepts only `GATEWAY_ACCESS_KEY` and `NODE_SECRETS_01..99`. Every Worker configuration value is validated against the 4.5 KB shard limit, and the same configuration loader used at runtime must report `ready` before the workflow changes Cloudflare.

After this one-time setup, push normally. The repository has no credential file to commit, and no Cloudflare Dashboard reconfiguration is needed after a code push.

### Changing runtime configuration

The runtime configuration package is intentionally separate from source code because it contains upstream credentials. Update the encrypted GitHub repository Secret, review the change through your secret-management process, then push the related code or configuration change. The next `main` deployment replaces Worker text variables and updates managed Worker Secrets automatically; obsolete `NODE_SECRETS_XX` shards are deleted in the same bulk operation. Do not edit these managed values in the Cloudflare Dashboard.

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

Use reconfigure only to recover or bootstrap a local/operator deployment. A subsequent GitHub deployment replaces its Worker text variables from `GATEWAY_RUNTIME_CONFIG`.

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
