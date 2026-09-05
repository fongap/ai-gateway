// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Public re-export surface for the token-usage store.
//
// The actual implementation lives in ./keys.js, ./writer.js,
// ./queries.js, ./aggregation.js, and ./retention.js. This module
// is the single import point for external consumers
// (src/runtime/cron.js, src/dashboard/pages.js,
// src/runtime/model-status.js, src/request/handler.js).

export {
  // Keys / shared constants
  TTFT_BUCKET_BOUNDARIES_MS,
  DISPLAY_TIMEZONE_OFFSET_MS,
  // Keys helpers
  utc8DayStartUtcMs,
  isoDayUtc8,
  normalizeHour,
  ttftBucketIndex,
  normalizeModelKey,
  tokenStatsD1,
} from './keys.js';

// Writer — single hot-path persistence entrypoint.
export { persistTokenUsage, tokenUsagePayload } from './writer.js';

// Queries — read paths for the dashboard, public model status, and
// TTFT percentiles.
export {
  queryTokenSummary,
  queryTokenDailySeries,
  queryTokenModelUsage,
  queryRecentModelEvidence,
  queryModelTtftPercentiles,
  queryModelUsageCoverage,
} from './queries.js';

// Aggregation — hourly → daily → weekly. Idempotent.
export { aggregateHourlyToDaily, aggregateDailyToWeekly } from './aggregation.js';

// Retention — delete expired rows from hourly / daily / weekly / per-model.
export {
  cleanupUsageRetention,
  cleanupModelStats,
  maintainUsageStats,
} from './retention.js';
