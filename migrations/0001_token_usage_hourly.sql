-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 Fongap Studio
--
-- Cross-isolate / cross-PoP / cross-restart token-usage aggregate.
--
-- Only HOURLY buckets are kept. The primary key is the UTC hour aligned key
-- ("2026-08-28T08:00:00Z"), so every isolate in every location writes the SAME
-- row for the same wall-clock hour and the UPSERT below is what makes the
-- cumulative counter correct under concurrency.
--
-- No per-request rows, no node / provider / tier / api-key / user / ip
-- dimensions: cardinality stays tiny and the free tier's write/read budget is
-- enough for the aggregate the public homepage needs.
--
-- Requests = usage_reports + usage_missing (invariant, verified by tests).

CREATE TABLE IF NOT EXISTS token_usage_hourly (
    hour TEXT PRIMARY KEY,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    usage_reports INTEGER NOT NULL DEFAULT 0,
    usage_missing INTEGER NOT NULL DEFAULT 0
);

-- Optional index for the rolling 24h / 7d WHERE hour >= ? window scans.
CREATE INDEX IF NOT EXISTS idx_token_usage_hourly_hour ON token_usage_hourly (hour);
