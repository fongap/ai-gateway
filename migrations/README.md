# D1 migrations

This directory owns the ordered schema changes for ai-gateway token-usage observability.

## Production ordering

When `TOKEN_STATS_D1_ID` is configured, the production deployment path applies D1 migrations **before** publishing the new Worker:

```text
preflight + runtime configuration validation
        ↓
D1 migrations
        ↓
atomic Worker deployment
        ↓
remote verification
        ↓
success / Worker rollback on post-deploy failure
```

A migration failure blocks the Worker deployment. If D1 is not configured, the migration step is skipped.

Worker rollback does **not** undo an already-applied D1 migration. New migrations must therefore remain compatible with the previous Worker version that may be restored during rollback.

See [Deployment](../docs/operations/deployment.md) for the complete production sequence.

## Governance

`npm run migrations:check` enforces the executable migration contract:

1. SQL migration files use `NNN_slug.sql` names with unique, consecutive numeric prefixes.
2. Applied SQL files are immutable. Schema corrections are added as a new migration rather than editing, deleting, or renaming an existing migration.
3. `CREATE TABLE` / `CREATE INDEX` statements use `IF NOT EXISTS` where applicable so safe re-application remains possible.
4. Destructive operations are blocked by default because they can break rollback compatibility.
5. A destructive migration is allowed only through the explicit allowlist in `scripts/migrations-check.mjs` after backward compatibility has been established.

`0007_drop_redundant_usage_indexes.sql` is the current explicit allowlisted cleanup: it removes redundant indexes without changing the schema expected by the previous Worker.

Keep each new migration focused and forward-compatible. Do not rely on a Worker rollback to restore database schema.

## Current schema history

| Migration | Change |
| --- | --- |
| `0001_token_usage_hourly.sql` | Adds global hourly token-usage aggregation |
| `0002_token_usage_model_hourly.sql` | Adds per-model hourly aggregation used by model status and dashboard reads |
| `0003_token_usage_ttft_histogram.sql` | Adds bucketed TTFT histogram storage |
| `0004_token_usage_totals.sql` | Adds cumulative token-usage totals |
| `0005_token_usage_daily.sql` | Adds UTC+8 daily aggregation for the activity heatmap |
| `0006_token_usage_weekly.sql` | Adds UTC+8 weekly aggregation for rolling activity views |
| `0007_drop_redundant_usage_indexes.sql` | Removes redundant indexes already covered by primary-key indexes |
| `0008_token_usage_cache_tokens.sql` | Adds Anthropic prompt-cache creation/read token breakdown columns to usage tables |

The SQL files themselves are the schema-change source of truth; this table is only an index.

## Validation

Run:

```bash
npm run migrations:check
```

The governance check is covered by [`tests/migrations-check-test.mjs`](../tests/migrations-check-test.mjs) and is included in both merge and deploy validation.

Do not add a separate migration runner or parallel schema history unless the deployment mechanism actually changes.
