-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 Fongap Studio
--
-- Weekly aggregates keyed by the Monday start date (UTC) of the ISO week
-- (YYYY-MM-DD). Retention: 52 weeks.
-- Derived from token_usage_daily by the scheduled maintenance job.
-- Idempotent: each run recomputes all weekly buckets from current daily
-- data and overwrites — no double-counting.

CREATE TABLE IF NOT EXISTS token_usage_weekly (
    week_start TEXT PRIMARY KEY,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    usage_reports INTEGER NOT NULL DEFAULT 0,
    usage_missing INTEGER NOT NULL DEFAULT 0
);