# D1 migrations

This directory holds the canonical D1 schema for the **token-usage
observability** D1 database. The D1 binding name is **`TOKEN_STATS_DB`**.

Migrations are applied **in numeric order** at deploy time by the GitHub Actions
deploy workflow (and by `scripts/deploy.sh` / `deploy.ps1` / `update.sh` /
`update.ps1` on a local deploy when the binding is present). The deploy
workflow runs D1 migrations AFTER `wrangler deploy` so the Worker is already
serving the new code path; rolling-deploy safety is provided by the existing
fail-open fallbacks documented in `docs/operations/deployment.md` (Dashboard
reads fall back from totals→hourly, heatmap from daily→hourly+today, model
status continues to read `token_usage_model_hourly` 24h).

**A failing migration blocks the deploy.** Nothing in production is updated
until every migration in this directory has been applied to the remote D1.

## Governance

1. **File naming** — every migration is `<NNN>_<short_slug>.sql` where
   `NNN` is a zero-padded monotonic counter. Numbers MUST be unique and
   strictly increasing. Re-using a number for a new schema change is a
   governance violation and is rejected by `npm run migrations:check`.
2. **No edits to applied files** — once a migration is part of a release,
   its SQL is immutable. Schema corrections always go in a new migration
   (forward-only). `npm run migrations:check` refuses modified files.
3. **Idempotent SQL** — every migration uses `CREATE TABLE IF NOT EXISTS`
   and `CREATE INDEX IF NOT EXISTS`. Cloudflare D1 does not track applied
   migration history (there is no `migrations` table), so re-running the
   sequence is a no-op for every table the file declares. This is the
   only safety net we have against partial deploys and re-runs.
4. **One logical change per file** — bundling unrelated schema changes into
   a single migration is rejected by `npm run migrations:check` (the
   commit message and the file name are required to describe a single
   concern; reviewers can challenge combined migrations).
5. **No data loss in the same migration as a schema change** — destructive
   operations (DROP COLUMN, RENAME) MUST be a separate migration so a
   rolling deploy can reason about each step independently.
6. **Local first** — every migration is exercised locally with
   `npm run migrations:apply --local` (and covered by the unit tests in
   `scripts/migrations-test.mjs`) BEFORE the PR is merged. The deploy
   workflow will still run them, but only after the test pass on main.

## Current schema

| Migration | Adds |
|---|---|
| `0001_token_usage_hourly.sql` | `token_usage_hourly` — the global hourly aggregate. PK = UTC hour key. |
| `0002_token_usage_model_hourly.sql` | `token_usage_model_hourly` — per-model hourly window for the homepage / model status. |
| `0003_token_usage_ttft_histogram.sql` | `token_usage_ttft_histogram` — bucketed TTFT counts for the dashboard. |
| `0004_token_usage_totals.sql` | `token_usage_totals` — single-row cumulative counter, read by the public homepage. |
| `0005_token_usage_daily.sql` | `token_usage_daily` — UTC+8 daily aggregate for the heatmap. |
| `0006_token_usage_weekly.sql` | `token_usage_weekly` — UTC+8 weekly aggregate for the rolling 52-week chart. |
| `0007_drop_redundant_usage_indexes.sql` | Drops redundant PK indexes on hourly / model_hourly (PK index is already implicit on the PK column). |

The full retention policy and the fail-open fallback chain are documented in
`docs/operations/deployment.md` and `docs/architecture/observability.md`.

## How the deploy applies migrations

```
wrangler deploy --dry-run          # validates the new Worker code path
  → wrangler deploy                # publishes the new Worker
  → scripts/apply-d1-migrations.sh # wrangler d1 migrations apply TOKEN_STATS_DB
                                  # (drives migrations/ in numeric order)
  → verify deployed gateway
```

If `TOKEN_STATS_DB` is not bound (free-tier / observability-disabled
deployments), the migrations step is skipped automatically and the deploy
succeeds. Token usage then falls back to the in-memory aggregator that
ships with the Worker.

## Validation

`npm run migrations:check` enforces the governance rules above:
- monotonic numeric prefix,
- unique numbers,
- one `0001` / `0007` (etc.) per logical concern,
- `IF NOT EXISTS` on every `CREATE` (so re-applies are no-ops),
- no file deletions or renames in the working tree.

The check is part of `npm run validate:merge` and `npm run validate:deploy`.
