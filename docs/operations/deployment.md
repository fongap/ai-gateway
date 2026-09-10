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
remote gateway verification
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

A commit that changes only Markdown files and/or `docs/**` is intentionally skipped by the deployment gate. Documentation governance changes therefore do not republish the Worker merely because they reached `main`.

## Manual Deploy

`workflow_dispatch` on the Deploy workflow is allowed, but it is not a validation bypass. The manual path runs:

```bash
npm run validate:deploy
npm run check:deploy
```

before the deploy job can proceed.

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

Config and Secret shards are independent partitions. Runtime binding is by **Tier + node id**, not by matching `_01`, `_02`, and so on.

To add or rotate an upstream key:

1. keep the node in the appropriate `TIER*_NODES_CONFIG_XX` Variable;
2. add/update its credential under the same node id in any Secret shard for the same tier;
3. let the next production deployment rebuild the runtime configuration.

Do not place credentials in node JSON.

## Gateway access groups

Client access is grouped:

```text
GATEWAY_ACCESS_KEY_AIR       + GATEWAY_ACCESS_MODELS_AIR
GATEWAY_ACCESS_KEY_PRO       + GATEWAY_ACCESS_MODELS_PRO
GATEWAY_ACCESS_KEY_MAX       + GATEWAY_ACCESS_MODELS_MAX
GATEWAY_ACCESS_KEY_ULTRA     + GATEWAY_ACCESS_MODELS_ULTRA
GATEWAY_ACCESS_KEY_AGENT     + GATEWAY_ACCESS_MODELS_AGENT
```

A configured key with an empty/missing model allowlist is fail-closed and grants zero model access.

## D1 migration ordering

When token-usage D1 is configured, ordered migrations run **before** Worker deployment. A migration failure stops deployment so new code is not intentionally published against an older required schema.

D1 migration is not transactionally rolled back with a Worker rollback. Migration design must therefore remain backward-compatible with the previous Worker version used by automatic rollback.

## Atomic Worker deployment

The production workflow deploys Worker code and the prepared Secret/variable payload in the same Wrangler deployment operation so the resulting Worker version sees the intended configuration set.

The local wrapper `scripts/cloudflare-wrangler.mjs` owns the pinned Wrangler CLI and local binding/migration behavior. `wrangler.user.jsonc` is operator-local and gitignored.

## Verification and rollback

After deployment, the workflow verifies the deployed gateway. If deployment happened but post-deploy verification fails, the workflow attempts to roll back the Worker version and verifies the rolled-back gateway.

Automatic rollback covers the Worker version/configuration represented by the deployment mechanism. It does not undo an already-applied D1 migration.

A failed rollback or failed rollback verification requires operator intervention rather than repeated blind deployment.

## Release identity vs. build identity

`/version` separates:

- `version` — SemVer release/source identity generated from `package.json`;
- `build` — deployed commit SHA injected by the CI/Deploy path.

The deploy verifier can therefore prove which commit is live without changing the semantic version for every deployment.

## Repository protection

The intended repository settings are documented in [github-repository-settings.md](github-repository-settings.md). In particular, `validate-merge` is the PR-time required check; Deploy is a post-merge production workflow and should not be configured as a PR required check.

## Local/operator checks

Before a manual production action:

```bash
npm ci
npm run validate:deploy
npm run check:deploy
```

For configuration semantics, see [Configuration](configuration.md). For formal version/tag sequencing, see [Version policy](../governance/version-policy.md).
