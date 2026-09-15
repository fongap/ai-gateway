// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Public re-export surface for the token-usage store.

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

export { persistTokenUsage, persistUpstreamAttemptUsage, tokenUsagePayload } from './writer.ts';

// Delivered-response queries remain the source for Public Model Status / TTFT.
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

// Dashboard consumption queries: physical upstream attempts, including failed
// fallback/retry/hedge work when the upstream reported usage.
export {
  queryUpstreamTokenSummary,
  queryUpstreamTokenDailySeries,
  queryUpstreamTokenModelUsage,
} from './upstream-queries.ts';

export { aggregateHourlyToDaily, aggregateDailyToWeekly } from './aggregation.ts';

export {
  cleanupUsageRetention,
  cleanupModelStats,
  maintainUsageStats,
} from './retention.ts';
