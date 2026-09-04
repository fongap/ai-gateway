// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Shared constants, types, and tiny helpers for the token-usage
// persistence layer. This module is the single source of truth for
// table names, retention windows, bucket boundaries, and display
// timezone math that all of writer / queries / aggregation /
// retention use.
//
// Timezone note: D1 stores UTC hourly buckets. UTC+8 is used ONLY
// for natural-day boundaries (今日, 热力图日期, 星期, 月份).
// Rolling windows (24h, 7d, cumulative) remain UTC-based sliding
// windows.

export const TABLE = 'token_usage_hourly';
export const TABLE_MODEL = 'token_usage_model_hourly';
export const TABLE_TOTALS = 'token_usage_totals';
export const TABLE_DAILY = 'token_usage_daily';
export const TABLE_WEEKLY = 'token_usage_weekly';

export const HOUR_MS = 3600_000;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

// Retention policies (in milliseconds).
export const HOURLY_RETENTION_MS = 7 * DAY_MS;
export const DAILY_RETENTION_MS = 52 * WEEK_MS;
export const WEEKLY_RETENTION_MS = 52 * WEEK_MS;

// TTFT histogram bucket boundaries (milliseconds). 7 buckets indexed 0..6.
// Only successful requests produce TTFT samples — failures enter failure
// statistics only.
//   b0: < 100ms       (very fast / cached)
//   b1: 100-500ms     (fast)
//   b2: 500ms-1s      (medium)
//   b3: 1-2s          (slow)
//   b4: 2-5s          (very slow)
//   b5: 5-10s         (extremely slow)
//   b6: >= 10s        (timeout territory)
export const TTFT_BUCKET_BOUNDARIES_MS = [100, 500, 1000, 2000, 5000, 10000];
export const TTFT_BUCKET_COUNT = 7;

// Centralized display timezone offset (UTC+8) for natural-day boundaries.
// All UTC+8 day calculations MUST use this constant to avoid scattered
// "+8h" logic.
export const DISPLAY_TIMEZONE_OFFSET_MS = 8 * 60 * 60 * 1000;

// Return the UTC millisecond timestamp of the Beijing (UTC+8) midnight for
// the given UTC timestamp. The result is always hour-aligned (Beijing
// 00:00 = 16:00Z).
export function utc8DayStartUtcMs(now = Date.now()) {
  return Math.floor((now + DISPLAY_TIMEZONE_OFFSET_MS) / DAY_MS) * DAY_MS - DISPLAY_TIMEZONE_OFFSET_MS;
}

// Return the UTC+8 date string (YYYY-MM-DD) for the given UTC timestamp.
export function isoDayUtc8(ms) {
  return new Date(ms + DISPLAY_TIMEZONE_OFFSET_MS).toISOString().slice(0, 10);
}

// UTC hour key, e.g. "2026-08-28T08:00:00Z". All buckets are aligned to
// the hour in UTC so isolates in different PoPs write the SAME key for
// the same wall-clock hour, which is what makes cross-isolate
// aggregation meaningful.
export function normalizeHour(date = Date.now()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hour = String(d.getUTCHours()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:00:00Z`;
}

// Map a TTFT value (ms) to a histogram bucket index [0..6].
// Returns -1 for invalid/negative values (should not be recorded).
// Infinity maps to the last bucket (timeout territory).
export function ttftBucketIndex(ttftMs) {
  if (ttftMs === Infinity) return TTFT_BUCKET_COUNT - 1;
  if (!Number.isFinite(ttftMs) || ttftMs < 0) return -1;
  for (let i = 0; i < TTFT_BUCKET_BOUNDARIES_MS.length; i++) {
    if (ttftMs < TTFT_BUCKET_BOUNDARIES_MS[i]) return i;
  }
  return TTFT_BUCKET_COUNT - 1;
}

// Canonical statistical model key: trim + lowercase.
// Used ONLY in the observability layer (D1 stats, TTFT, coverage). It
// never affects routing/auth/model-id exactness (which keep official
// casing). Merges Code-Max / code-max / CODE-MAX into one stats
// dimension.
export function normalizeModelKey(model) {
  return String(model || '').trim().toLowerCase();
}

// Resolve the D1 binding (env.TOKEN_STATS_DB). Returns null when the
// binding is absent or not a real D1 database — every query / write
// path fails open in that case.
export function tokenStatsD1(env) {
  const d1 = env?.TOKEN_STATS_DB;
  if (!d1 || typeof d1.prepare !== 'function') {
    return null;
  }
  return d1;
}
