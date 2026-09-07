-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 Fongap Studio
--
-- Add Anthropic Prompt Cache token columns to all token usage tables.
-- These columns track cache_creation_input_tokens and cache_read_input_tokens
-- which are ADDITIONAL input activity on top of ordinary input_tokens.
-- OpenAI cached_tokens are NOT added here (they're already part of prompt_tokens).
--
-- total_tokens in all tables already includes cache tokens for Anthropic
-- (effectiveInput + output). This migration adds the breakdown columns.

-- token_usage_hourly
ALTER TABLE token_usage_hourly ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_hourly ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;

-- token_usage_model_hourly
ALTER TABLE token_usage_model_hourly ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_model_hourly ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;

-- token_usage_totals
ALTER TABLE token_usage_totals ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_totals ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;

-- token_usage_daily
ALTER TABLE token_usage_daily ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_daily ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;

-- token_usage_weekly
ALTER TABLE token_usage_weekly ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_usage_weekly ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;