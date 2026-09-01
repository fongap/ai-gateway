-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 Fongap Studio
--
-- TTFT histogram for successful requests (per-model, per-hour).
--
-- This migration adds coarse-grained histogram buckets to track Time To
-- First Token for successful requests only. Failed requests NEVER produce
-- TTFT samples — they enter failure statistics only.
--
-- Bucket boundaries (milliseconds):
--   b0: < 100ms       (very fast / cached)
--   b1: 100–500ms     (fast)
--   b2: 500ms–1s      (medium)
--   b3: 1–2s          (slow)
--   b4: 2–5s          (very slow)
--   b5: 5–10s         (extremely slow)
--   b6: ≥ 10s         (timeout territory)
--
-- successful_ttft_count tracks how many successful requests contributed
-- TTFT samples. Dashboard uses this to decide "样本不足" vs real percentiles.
--
-- Old latency data that cannot distinguish success/failure is NOT
-- reinterpreted as Successful TTFT. New metrics accumulate from
-- the version that runs this migration onward.
--
-- This migration is applied once through Wrangler D1 migrations.

ALTER TABLE token_usage_model_hourly
    ADD COLUMN successful_ttft_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_model_hourly
    ADD COLUMN ttft_b0 INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_model_hourly
    ADD COLUMN ttft_b1 INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_model_hourly
    ADD COLUMN ttft_b2 INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_model_hourly
    ADD COLUMN ttft_b3 INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_model_hourly
    ADD COLUMN ttft_b4 INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_model_hourly
    ADD COLUMN ttft_b5 INTEGER NOT NULL DEFAULT 0;

ALTER TABLE token_usage_model_hourly
    ADD COLUMN ttft_b6 INTEGER NOT NULL DEFAULT 0;
