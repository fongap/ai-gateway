# Deployment

Production deployment is driven by GitHub Actions. GitHub repository Variables hold non-sensitive configuration; Secrets hold credentials. Cloudflare is the execution target, not the canonical configuration editor.

## Production path

```text
Pull Request
    ↓
validate-merge + Worker dry-run
    ↓
squash merge to main
    ↓
main CI
  ├─ validate-merge
  └─ validate-deploy
    ↓ both succeed on a push-triggered CI run
Deploy workflow gate
    ↓
preflight configuration
    ↓
runtime configuration validation
    ↓
D1 migrations (when configured)
    ↓
atomic Worker code + secret deployment
    ↓
remote verification by commit SHA
    ↓
success / automatic Worker rollback on post-deploy failure
```

The production gate is stricter than the PR merge gate. A PR can merge after the required merge check; production deployment waits for the full `main` CI result.

## Automatic deployment eligibility

`scripts/deploy-gate-decision.mjs` owns the deployment gate. Automatic deployment is allowed only when:

- the completed CI run belongs to this repository rather than a fork;
- that CI run was triggered by a `push`;
- its conclusion is `success`;
- the triggering commit contains a deployable change.

Scheduled CI and manually triggered CI are test-only and do not automatically deploy.

A commit that changes only Markdown files and/or `docs/**` is intentionally skipped by the deployment gate.

## Manual Deploy workflow

`workflow_dispatch` is allowed, but it is not a validation bypass. The manual path runs:

```bash
npm run validate:deploy
npm run check:deploy
```

before deployment.

## Local/operator lifecycle

- `scripts/install.sh` / `scripts/install.ps1` — first-time local bootstrap and initial direct deployment.
- `scripts/reconfigure.sh` / `scripts/reconfigure.ps1` — update operator configuration and deploy it.
- `npm run deploy` — supported direct local code-deploy entry point for an already configured checkout.
- `npm run cf:login`, `npm run cf:whoami`, `npm run tail` — Cloudflare operator commands.

All direct Cloudflare CLI calls route through `scripts/cloudflare-wrangler.mjs`. Do not add parallel deploy/update aliases.

The tracked `wrangler.jsonc` is the repository baseline. Local Worker name, bindings, and operator configuration belong in gitignored `wrangler.user.jsonc`; installer/reconfigure tooling must not rewrite the tracked baseline.

## Required configuration

Core GitHub Variables include:

- `CLOUDFLARE_ACCOUNT_ID`
- `GATEWAY_PUBLIC_BASE_URL`
- at least one `TIER{1,2,3}_NODES_CONFIG_XX` shard
- `TIER1_AFFINITY_KV_ID` when Tier 1 affinity is used
- optional `TOKEN_STATS_D1_ID`
- corresponding `GATEWAY_ACCESS_MODELS_{AIR,PRO,MAX,ULTRA,AGENT}` values for configured access groups
- optional `MODELS_CONFIG`, `POLICIES_CONFIG`, and runtime variables

Core GitHub Secrets include:

- `CLOUDFLARE_API_TOKEN`
- at least one `GATEWAY_ACCESS_KEY_{AIR,PRO,MAX,ULTRA,AGENT}`
- tier-scoped `TIER{1,2,3}_NODES_SECRETS_01..10` containing `{ "node-id": "credential" }`

The deployment preflight fails closed on missing required production inputs.

## Node credential binding

Config and Secret shards are independent partitions. Runtime binding is by **Tier + node id**, not by matching shard suffixes.

To add or rotate an upstream key:

1. keep the node in the appropriate `TIER*_NODES_CONFIG_XX` Variable;
2. add/update its credential under the same node id in any Secret shard for the same tier;
3. let the next production deployment rebuild runtime configuration.

Do not place credentials in node JSON.

## Gateway access groups

```text
GATEWAY_ACCESS_KEY_AIR       + GATEWAY_ACCESS_MODELS_AIR
GATEWAY_ACCESS_KEY_PRO       + GATEWAY_ACCESS_MODELS_PRO
GATEWAY_ACCESS_KEY_MAX       + GATEWAY_ACCESS_MODELS_MAX
GATEWAY_ACCESS_KEY_ULTRA     + GATEWAY_ACCESS_MODELS_ULTRA
GATEWAY_ACCESS_KEY_AGENT     + GATEWAY_ACCESS_MODELS_AGENT
```

A configured key with an empty/missing model allowlist is fail-closed and grants zero model access.

## D1 migration ordering

When token-usage D1 is configured, ordered migrations run **before** Worker deployment. A migration failure stops deployment.

D1 migration is not transactionally rolled back with Worker code. Migration design must therefore be operationally safe for the deployment sequence. Do not solve migration safety by keeping retired application contracts, aliases, or dual runtime paths alive.

## Atomic Worker deployment

The production workflow deploys Worker code and the prepared Secret/variable payload in the same Wrangler operation so the resulting deployment sees the intended configuration set.

For direct local operations, `scripts/cloudflare-wrangler.mjs` owns the pinned Wrangler CLI and local binding/migration behavior. When `wrangler.user.jsonc` exists, the wrapper uses it by default unless an explicit config is supplied.

## Verification and rollback

The CI/Deploy path injects the deployed Git commit SHA as `GITHUB_SHA`. Authenticated `/health` exposes it as `build`.

Post-deploy verification requires `/health.build` to equal the exact commit SHA selected by the Deploy workflow, then verifies `/v1/models` and local count-tokens behavior. This proves which commit is live without any project release number in runtime source.

If post-deploy verification fails, the workflow attempts to roll back the Worker deployment and verifies the rollback. An already-applied D1 migration is not undone automatically.

A failed rollback or failed rollback verification requires operator intervention rather than repeated blind deployment.

Project release numbering is not part of deployment automation. If a named release is desired, the operator creates a Git tag or GitHub Release manually after selecting the intended commit.

## Repository protection

The intended repository settings are documented in [github-repository-settings.md](github-repository-settings.md). `validate-merge` is the PR-time required check; Deploy is a post-merge production workflow and should not be configured as a PR required check.

## Local/operator checks

```bash
npm ci
npm run validate:deploy
npm run check:deploy
```

For configuration semantics, see [Configuration](configuration.md). For tooling entry points, see [`scripts/README.md`](../../scripts/README.md).
