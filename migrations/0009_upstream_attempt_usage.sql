-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 Fongap Studio
--
-- Separate physical-upstream-attempt usage from delivered-response usage.
--
-- Existing columns keep their established meaning: one successfully delivered
-- response entered token stats, and `requests` remains valid success evidence
-- for Public Model Status / TTFT. The new upstream_* columns count every REAL
-- upstream dispatch for which the gateway reaches an accounting terminal point
-- (primary, fallback, retry, or hedge twin). Tokens are recorded only when the
-- upstream actually reports usage; missing reports are counted, never estimated.
--
-- Historical failed-attempt usage cannot be reconstructed. Initialize the new
-- columns from the delivered-response columns so pre-migration history remains
-- a conservative known lower bound instead of dropping to zero. Post-migration
-- writes account physical attempts explicitly.

-- token_usage_hourly
ALTER TABLE token_usage_hourly ADD COLUMN upstream_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_usage_reports INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN upstream_usage_missing INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_hourly SET
  upstream_input_tokens = input_tokens,
  upstream_output_tokens = output_tokens,
  upstream_cache_creation_input_tokens = cache_creation_input_tokens,
  upstream_cache_read_input_tokens = cache_read_input_tokens,
  upstream_total_tokens = total_tokens,
  upstream_attempts = requests,
  upstream_usage_reports = usage_reports,
  upstream_usage_missing = usage_missing;

-- token_usage_model_hourly
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_usage_reports INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN upstream_usage_missing INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_model_hourly SET
  upstream_input_tokens = input_tokens,
  upstream_output_tokens = output_tokens,
  upstream_cache_creation_input_tokens = cache_creation_input_tokens,
  upstream_cache_read_input_tokens = cache_read_input_tokens,
  upstream_total_tokens = total_tokens,
  upstream_attempts = requests,
  upstream_usage_reports = usage_reports,
  upstream_usage_missing = usage_missing;

-- token_usage_totals
ALTER TABLE token_usage_totals ADD COLUMN upstream_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_usage_reports INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN upstream_usage_missing INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_totals SET
  upstream_input_tokens = input_tokens,
  upstream_output_tokens = output_tokens,
  upstream_cache_creation_input_tokens = cache_creation_input_tokens,
  upstream_cache_read_input_tokens = cache_read_input_tokens,
  upstream_total_tokens = total_tokens,
  upstream_attempts = requests,
  upstream_usage_reports = usage_reports,
  upstream_usage_missing = usage_missing;

-- token_usage_daily
ALTER TABLE token_usage_daily ADD COLUMN upstream_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_usage_reports INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN upstream_usage_missing INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_daily SET
  upstream_input_tokens = input_tokens,
  upstream_output_tokens = output_tokens,
  upstream_cache_creation_input_tokens = cache_creation_input_tokens,
  upstream_cache_read_input_tokens = cache_read_input_tokens,
  upstream_total_tokens = total_tokens,
  upstream_attempts = requests,
  upstream_usage_reports = usage_reports,
  upstream_usage_missing = usage_missing;

-- token_usage_weekly
ALTER TABLE token_usage_weekly ADD COLUMN upstream_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_usage_reports INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN upstream_usage_missing INTEGER NOT NULL DEFAULT 0;
UPDATE token_usage_weekly SET
  upstream_input_tokens = input_tokens,
  upstream_output_tokens = output_tokens,
  upstream_cache_creation_input_tokens = cache_creation_input_tokens,
  upstream_cache_read_input_tokens = cache_read_input_tokens,
  upstream_total_tokens = total_tokens,
  upstream_attempts = requests,
  upstream_usage_reports = usage_reports,
  upstream_usage_missing = usage_missing;