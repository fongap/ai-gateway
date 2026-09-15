// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Public re-export surface for the token-usage store.
//
// The actual implementation lives in ./keys.ts, ./writer.ts,
// ./queries.ts, ./aggregation.ts, and ./retention.ts. This module
// is the single import point for external consumers.

export {
  TTFT_BUCKET_BOUNDARIES_MS,
  DISPLAY_TIMEZONE_OFFSET_MS,
  utc8DayStartUtcMs,
  isoDayUtc8,
  normalizeHour,
  ttftBucketIndex,
  normalizeModelKey,
  tokenStatsD1,
} from './keys.ts';

// Writer — delivered-response persistence plus non-delivered physical upstream
// attempt persistence. A successful delivered response updates both accounting
// views in one write set; persistUpstreamAttemptUsage is only for attempts that
// did not become the delivered response.
export { persistTokenUsage, persistUpstreamAttemptUsage, tokenUsagePayload } from './writer.ts';

export {
  queryTokenSummary,
  queryTokenDailySeries,
  queryTokenModelUsage,
  MODEL_STATUS_RECENT_WINDOW_MS,
  MODEL_STATUS_HISTORICAL_WINDOW_MS,
  queryAllModelsTtftPercentiles,
  queryRecentModelEvidence,
  queryModelUsageCoverage,
} from './queries.ts';

export { aggregateHourlyToDaily, aggregateDailyToWeekly } from './aggregation.ts';

export {
  cleanupUsageRetention,
  cleanupModelStats,
  maintainUsageStats,
} from './retention.ts';
