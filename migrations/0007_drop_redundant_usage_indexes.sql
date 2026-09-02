-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 Fongap Studio
--
-- Drop redundant indexes that duplicate PRIMARY KEY implicit indexes.
-- token_usage_hourly: PRIMARY KEY(hour) already provides an index on hour.
-- token_usage_model_hourly: PRIMARY KEY(hour, model) covers queries on hour
-- alone via leftmost prefix. The separate index on (hour) is redundant.
-- Safe to drop because all existing queries use the PK index instead.

DROP INDEX IF EXISTS idx_token_usage_hourly_hour;
DROP INDEX IF EXISTS idx_token_usage_model_hourly_hour;