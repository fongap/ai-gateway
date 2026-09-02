-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 Fongap Studio
--
-- Daily aggregates keyed by UTC+8 calendar date (YYYY-MM-DD).
-- This is the display-oriented layer that powers the 52-week heatmap.
-- Retention: 52 weeks (aligned to the heatmap's 52-week grid).
-- Aggregated from token_usage_hourly by the scheduled maintenance job.
-- Idempotent: each run recomputes all daily buckets from current hourly
-- data and overwrites — no double-counting.

CREATE TABLE IF NOT EXISTS token_usage_daily (
    day TEXT PRIMARY KEY,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    usage_reports INTEGER NOT NULL DEFAULT 0,
    usage_missing INTEGER NOT NULL DEFAULT 0
);