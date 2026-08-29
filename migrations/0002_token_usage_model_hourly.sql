-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 Fongap Studio
--
-- Per-model hourly aggregate (companion to token_usage_hourly).
--
-- The global token_usage_hourly table deliberately omits model identity
-- (cardinality must stay tiny for the free-tier write/read budget). This
-- second table adds the model dimension ONLY for the public homepage's
-- "模型使用 · 近 7 天" panel — a single, bounded query against a bounded
-- window. Rows older than 7 days are not queried by the dashboard and are
-- pruned daily by the Worker Cron Trigger configured in wrangler.jsonc.
--
-- Cardinality: O(models × hours). With up to 8 logical models and 168 hours
-- per week window, the live footprint is tiny. PRIMARY KEY (hour, model)
-- keeps the UPSERT atomic across isolates — same UPSERT-into-aggregate
-- discipline as the global table.

CREATE TABLE IF NOT EXISTS token_usage_model_hourly (
    hour TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    usage_reports INTEGER NOT NULL DEFAULT 0,
    usage_missing INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, model)
);

-- Speeds up the "近 7 天" window scan (WHERE hour >= ? GROUP BY model).
CREATE INDEX IF NOT EXISTS idx_token_usage_model_hourly_hour
    ON token_usage_model_hourly (hour);
