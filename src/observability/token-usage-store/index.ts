// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Public re-export surface for the token-usage store.
//
// The actual implementation lives in ./keys.ts, ./writer.ts,
// ./queries.ts, ./aggregation.ts, and ./retention.ts. This module
// is the single import point for external consumers
// (src/dashboard/pages.ts, src/runtime/model-status.ts,
// src/request/handler.ts).

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
} from './keys.ts';

// Writer — single hot-path persistence entrypoint.
export { persistTokenUsage, tokenUsagePayload } from './writer.ts';

// Queries — read paths for the dashboard, public model status, and
// TTFT percentiles.
export {
  queryTokenSummary,
  queryTokenDailySeries,
  queryTokenModelUsage,
  MODEL_STATUS_RECENT_WINDOW_MS,
  queryAllModelsTtftPercentiles,
  queryRecentModelEvidence,
  queryModelUsageCoverage,
} from './queries.ts';

// Aggregation — hourly → daily → weekly. Idempotent.
export { aggregateHourlyToDaily, aggregateDailyToWeekly } from './aggregation.ts';

// Retention — delete expired rows from hourly / daily / weekly / per-model.
export {
  cleanupUsageRetention,
  cleanupModelStats,
  maintainUsageStats,
} from './retention.ts';
