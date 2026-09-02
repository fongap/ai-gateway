// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Cloudflare D1 token-usage persistence and query store: the ONLY cross-isolate / cross-PoP /
// cross-restart durable counter. This is a FAIL-OPEN observability module, not
// a business dependency:
//
//   * The binding is optional. If env.TOKEN_STATS_DB is absent (or is not a
//     usable D1), persistence is a no-op and every query reports "unavailable".
//   * persistTokenUsage() never throws into a request: callers must wrap the
//     returned promise in ctx.waitUntil(...).catch(...). Even a write that
//     rejects is swallowed and never affects the HTTP response, fallback,
//     node health, circuit breaker, scheduler or concurrency counters.
//   * Only HOURLY AGGREGATES are stored — one row per UTC hour, updated with a
//     single atomic UPSERT. No per-request rows, no per-node / per-provider /
//     per-key / per-user high-cardinality dimensions.
//   * Requests are NEVER estimated and NEVER buffered: usage is only the
//     upstream-reported usage, normalized by src/observability/token-usage.mjs.
//
// Invariant (verified independently of any isolate):
//   requests = usage_reports + usage_missing
// within the set of completed-and-entered-token-stats AI responses.
//
// The hot path (src/request/handler.js) only calls persistTokenUsage() inside
// ctx.waitUntil(); the dashboard (src/dashboard/pages.js) calls
// queryTokenSummary() and degrades to "统计暂不可用" when the binding is absent or the query fails — never a fake 0.
//
// No external fonts, no framework, no chart library, no runtime dependency:
// plain HTML + inline CSS + one tiny inline script (copy + tabs). Heatmap is
// 364 server-rendered <i> cells; hover uses native title attributes.
//
// Timezone: D1 stores UTC hourly buckets. UTC+8 is used ONLY for natural-day
// boundaries (今日, 热力图日期, 星期, 月份). Rolling windows (24h, 7d, cumulative)
// remain UTC-based sliding windows.

import { normalizeTokenUsage } from './token-usage.mjs';
import {
  getUtcDayBucket,
  getUtcWeekBucket,
  getUtcWeekStartUtcMs,
} from './time-buckets.mjs';

const TABLE = 'token_usage_hourly';
const TABLE_MODEL = 'token_usage_model_hourly';
const TABLE_TOTALS = 'token_usage_totals';
const TABLE_DAILY = 'token_usage_daily';
const TABLE_WEEKLY = 'token_usage_weekly';
const HOUR_MS = 3600_000;
const DAY_MS = 86400_000;
const WEEK_MS = 7 * DAY_MS;

// Retention policies (in milliseconds).
const HOURLY_RETENTION_MS = 7 * DAY_MS;
const DAILY_RETENTION_MS = 52 * WEEK_MS;
const WEEKLY_RETENTION_MS = 52 * WEEK_MS;

// TTFT histogram bucket boundaries (milliseconds).
// Only successful requests produce TTFT samples — failures enter failure
// statistics only. Bucket index 0-6 maps to columns ttft_b0..ttft_b6.
//   b0: < 100ms       (very fast / cached)
//   b1: 100–500ms     (fast)
//   b2: 500ms–1s      (medium)
//   b3: 1–2s          (slow)
//   b4: 2–5s          (very slow)
//   b5: 5–10s         (extremely slow)
//   b6: ≥ 10s         (timeout territory)
export const TTFT_BUCKET_BOUNDARIES_MS = [100, 500, 1000, 2000, 5000, 10000];
const TTFT_BUCKET_COUNT = 7;

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

// Centralized display timezone offset (UTC+8) for natural-day boundaries.
// All UTC+8 day calculations MUST use this constant to avoid scattered "+8h" logic.
export const DISPLAY_TIMEZONE_OFFSET_MS = 8 * 60 * 60 * 1000;

// Return the UTC millisecond timestamp of the Beijing (UTC+8) midnight for the
// given UTC timestamp. The result is always hour-aligned (Beijing 00:00 = 16:00Z).
export function utc8DayStartUtcMs(now = Date.now()) {
  return Math.floor((now + DISPLAY_TIMEZONE_OFFSET_MS) / DAY_MS) * DAY_MS - DISPLAY_TIMEZONE_OFFSET_MS;
}

// Return the UTC+8 date string (YYYY-MM-DD) for the given UTC timestamp.
export function isoDayUtc8(ms) {
  return new Date(ms + DISPLAY_TIMEZONE_OFFSET_MS).toISOString().slice(0, 10);
}

// UTC hour key, e.g. "2026-08-28T08:00:00Z". All buckets are aligned to the
// hour in UTC so isolates in different PoPs write the SAME key for the same
// wall-clock hour, which is what makes cross-isolate aggregation meaningful.
export function normalizeHour(date = Date.now()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hour = String(d.getUTCHours()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:00:00Z`;
}

// Derive the D1 aggregate payload for ONE delivered response from a raw
// upstream usage object. Exactly one of { reports: 1 } or { missing: 1 } is
// set; a normalized report carries its token totals. Returns null only when a
// caller passes something structurally unusable (defensive) — in practice the
// caller always passes either a usage object or null/undefined.
export function tokenUsagePayload(usage) {
  const normalized = normalizeTokenUsage(usage);
  if (normalized) {
    return {
      input: normalized.input,
      output: normalized.output,
      total: normalized.total,
      requests: 1,
      reports: 1,
      missing: 0,
    };
  }
  return { input: 0, output: 0, total: 0, requests: 1, reports: 0, missing: 1 };
}

// Where the D1 binding lives. Hoisted here so handler / dashboard / tests all
// agree on the single contract point.
export function tokenStatsD1(env) {
  const d1 = env?.TOKEN_STATS_DB;
  if (!d1 || typeof d1.prepare !== 'function') {
    return null;
  }
  return d1;
}

// Atomic per-hour UPSERT. One call = one response; the hour bucket is
// incremented by a single SQL statement so two isolates updating the same hour
// never lose a count (no SELECT-then-UPDATE race). `usage` is the RAW upstream
// usage (or null/undefined); it is normalized here, so a report and a missing
// response each produce exactly one payload. When `model` is a non-empty
// string, a parallel per-model UPSERT is fired (used by the homepage's
// "模型使用 · 近 7 天" panel). The per-model write is independent: its
// failure does not roll back the global aggregate. Additionally, the
// lifetime totals row (scope='global') is updated atomically. Returns a
// Promise that settles once ALL writes complete; a single classified rejection
// surfaces through the catch in the caller, which guarantees at most one log
// entry per delivered response. May reject — the caller is responsible for
// fail-open handling.
//
// `ttftMs` (optional) — successful TTFT in milliseconds. Only meaningful
// requests (success + meaningful output) should pass a value; failures MUST
// pass null/undefined so they never produce a TTFT sample. The value is
// bucketed into a coarse histogram (ttft_b0..ttft_b6) for percentile
// calculation without storing raw samples.
export function persistTokenUsage(env, usage, now = Date.now(), model = null, ttftMs = null) {
  const d1 = tokenStatsD1(env);
  if (!d1) return Promise.resolve();
  const hour = normalizeHour(now);
  const p = tokenUsagePayload(usage);
  let globalTask;
  try {
    const globalStmt = d1.prepare(
      `INSERT INTO ${TABLE} (
        hour,
        input_tokens,
        output_tokens,
        total_tokens,
        requests,
        usage_reports,
        usage_missing
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour) DO UPDATE SET
        input_tokens = ${TABLE}.input_tokens + excluded.input_tokens,
        output_tokens = ${TABLE}.output_tokens + excluded.output_tokens,
        total_tokens = ${TABLE}.total_tokens + excluded.total_tokens,
        requests = ${TABLE}.requests + excluded.requests,
        usage_reports = ${TABLE}.usage_reports + excluded.usage_reports,
        usage_missing = ${TABLE}.usage_missing + excluded.usage_missing`,
    );
    globalTask = Promise.resolve(globalStmt.bind(
      hour,
      p.input,
      p.output,
      p.total,
      p.requests,
      p.reports,
      p.missing,
    ).run());
  } catch (cause) {
    return Promise.reject(persistFailure('global', cause));
  }

  // Lifetime totals UPSERT (single row 'global'). Fail-open: errors are
  // logged but do not block the request path.
  let totalsTask;
  try {
    const totalsStmt = d1.prepare(
      `INSERT INTO ${TABLE_TOTALS} (
        scope, input_tokens, output_tokens, total_tokens,
        requests, usage_reports, usage_missing, updated_at
      )
      VALUES ('global', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        input_tokens = ${TABLE_TOTALS}.input_tokens + excluded.input_tokens,
        output_tokens = ${TABLE_TOTALS}.output_tokens + excluded.output_tokens,
        total_tokens = ${TABLE_TOTALS}.total_tokens + excluded.total_tokens,
        requests = ${TABLE_TOTALS}.requests + excluded.requests,
        usage_reports = ${TABLE_TOTALS}.usage_reports + excluded.usage_reports,
        usage_missing = ${TABLE_TOTALS}.usage_missing + excluded.usage_missing,
        updated_at = excluded.updated_at`,
    );
    totalsTask = Promise.resolve(totalsStmt.bind(
      p.input,
      p.output,
      p.total,
      p.requests,
      p.reports,
      p.missing,
      new Date(now).toISOString(),
    ).run());
  } catch (cause) {
    // Log but don't fail the request for totals write failures.
    console.error('token-stats totals persist failed:', cause?.message || cause);
    totalsTask = Promise.resolve();
  }

  if (typeof model !== 'string' || model.length === 0) {
    return Promise.allSettled([globalTask, totalsTask]).then(([globalResult, totalsResult]) => {
      if (globalResult.status === 'rejected') throw persistFailure('global', globalResult.reason);
      // totals failures already logged silently.
    });
  }

  // Compute TTFT histogram bucket counts for this single sample.
  // Only successful requests with meaningful output pass a valid ttftMs;
  // failures pass null so they never produce a TTFT sample.
  const buckets = Array.from({ length: TTFT_BUCKET_COUNT }, () => 0);
  let successTtftCount = 0;
  if (ttftMs != null) {
    const bi = ttftBucketIndex(ttftMs);
    if (bi >= 0) {
      buckets[bi] = 1;
      successTtftCount = 1;
    }
  }
  let modelTask;
  try {
    modelTask = Promise.resolve(d1.prepare(
      `INSERT INTO ${TABLE_MODEL} (
        hour, model,
        input_tokens, output_tokens, total_tokens,
        requests, usage_reports, usage_missing,
        successful_ttft_count,
        ttft_b0, ttft_b1, ttft_b2, ttft_b3, ttft_b4, ttft_b5, ttft_b6
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour, model) DO UPDATE SET
        input_tokens = ${TABLE_MODEL}.input_tokens + excluded.input_tokens,
        output_tokens = ${TABLE_MODEL}.output_tokens + excluded.output_tokens,
        total_tokens = ${TABLE_MODEL}.total_tokens + excluded.total_tokens,
        requests = ${TABLE_MODEL}.requests + excluded.requests,
        usage_reports = ${TABLE_MODEL}.usage_reports + excluded.usage_reports,
        usage_missing = ${TABLE_MODEL}.usage_missing + excluded.usage_missing,
        successful_ttft_count = ${TABLE_MODEL}.successful_ttft_count + excluded.successful_ttft_count,
        ttft_b0 = ${TABLE_MODEL}.ttft_b0 + excluded.ttft_b0,
        ttft_b1 = ${TABLE_MODEL}.ttft_b1 + excluded.ttft_b1,
        ttft_b2 = ${TABLE_MODEL}.ttft_b2 + excluded.ttft_b2,
        ttft_b3 = ${TABLE_MODEL}.ttft_b3 + excluded.ttft_b3,
        ttft_b4 = ${TABLE_MODEL}.ttft_b4 + excluded.ttft_b4,
        ttft_b5 = ${TABLE_MODEL}.ttft_b5 + excluded.ttft_b5,
        ttft_b6 = ${TABLE_MODEL}.ttft_b6 + excluded.ttft_b6`,
    ).bind(
      hour, model,
      p.input, p.output, p.total,
      p.requests, p.reports, p.missing,
      successTtftCount,
      buckets[0], buckets[1], buckets[2], buckets[3], buckets[4], buckets[5], buckets[6],
    ).run());
  } catch (cause) {
    modelTask = Promise.reject(cause);
  }
  return Promise.allSettled([globalTask, totalsTask, modelTask]).then(([globalResult, totalsResult, modelResult]) => {
    // Prefer the global aggregate failure when both writes fail: it is the
    // more important loss, and the request-level caller still emits exactly
    // one diagnostic. Promise.allSettled also observes both rejections, so no
    // secondary unhandled rejection can escape.
    if (globalResult.status === 'rejected') throw persistFailure('global', globalResult.reason);
    if (modelResult.status === 'rejected') throw persistFailure('per-model', modelResult.reason, model);
    // totals failures already logged silently.
  });
}

function persistFailure(scope, cause, model = null) {
  const error = new Error(cause?.message || String(cause || 'D1 persistence failure'), { cause });
  error.name = 'TokenStatsPersistError';
  error.scope = scope;
  if (model) error.model = model;
  return error;
}

// Aggregate summary for the public dashboard. Returns:
//   {
//     available: true,
//     today:      { total, requests },   // UTC+8 calendar day of `now`
//     cumulative: { total, requests, reports, missing }, // from lifetime totals
//     h24: { total, requests },          // rolling 24h from hourly
//     d7:  { total, requests },          // rolling 7d from hourly
//     coverage: <number|null>,           // reports / (reports + missing)
//   }
// or null when binding missing, or error object when query fails.
// "今日" follows UTC+8 day boundary; h24/d7 are rolling UTC windows.
// Cumulative now reads from token_usage_totals (survives hourly pruning).
// Falls back to hourly sum if totals table missing (rolling deploy safety).
export async function queryTokenSummary(env, now = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return null;
  const todayStart = normalizeHour(utc8DayStartUtcMs(now));
  const h24Start = normalizeHour(now - 24 * HOUR_MS);
  const d7Start = normalizeHour(now - 7 * DAY_MS);

  // First, try to read lifetime totals for cumulative KPIs.
  let totalsRow = null;
  try {
    const totalsStmt = d1.prepare(
      `SELECT input_tokens, output_tokens, total_tokens, requests, usage_reports, usage_missing
       FROM ${TABLE_TOTALS} WHERE scope = 'global'`
    );
    totalsRow = await totalsStmt.first();
  } catch (e) {
    // Totals table may not exist yet (migration pending). We'll fall back below.
  }

  // Rolling windows from hourly (hot path).
  const hourlyStmt = d1.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN hour >= ? THEN total_tokens END), 0) AS today_total,
       COALESCE(SUM(CASE WHEN hour >= ? THEN requests END), 0) AS today_requests,
       COALESCE(SUM(CASE WHEN hour >= ? THEN total_tokens END), 0) AS h24_total,
       COALESCE(SUM(CASE WHEN hour >= ? THEN requests END), 0) AS h24_requests,
       COALESCE(SUM(CASE WHEN hour >= ? THEN total_tokens END), 0) AS d7_total,
       COALESCE(SUM(CASE WHEN hour >= ? THEN requests END), 0) AS d7_requests
     FROM ${TABLE}`
  );
  let hourlyRow;
  try {
    hourlyRow = await hourlyStmt.bind(todayStart, todayStart, h24Start, h24Start, d7Start, d7Start).first();
  } catch (e) {
    return { available: false, error: `queryTokenSummary: ${e?.message || e}` };
  }
  if (!hourlyRow || typeof hourlyRow !== 'object') return null;

  // Cumulative from totals (with hourly fallback for rolling-deploy safety).
  let cum_total, cum_requests, cum_reports, cum_missing;
  if (totalsRow && typeof totalsRow === 'object') {
    cum_total = Number(totalsRow.total_tokens) || 0;
    cum_requests = Number(totalsRow.requests) || 0;
    cum_reports = Number(totalsRow.usage_reports) || 0;
    cum_missing = Number(totalsRow.usage_missing) || 0;
  } else {
    // Fallback: full scan of hourly (pre-migration or table missing).
    try {
      const fallbackStmt = d1.prepare(
        `SELECT COALESCE(SUM(total_tokens),0) AS t, COALESCE(SUM(requests),0) AS r,
                COALESCE(SUM(usage_reports),0) AS rp, COALESCE(SUM(usage_missing),0) AS rm
         FROM ${TABLE}`
      );
      const fb = await fallbackStmt.first();
      if (fb) {
        cum_total = Number(fb.t) || 0;
        cum_requests = Number(fb.r) || 0;
        cum_reports = Number(fb.rp) || 0;
        cum_missing = Number(fb.rm) || 0;
      } else {
        cum_total = cum_requests = cum_reports = cum_missing = 0;
      }
    } catch (e) {
      cum_total = cum_requests = cum_reports = cum_missing = 0;
    }
  }

  const reports = cum_reports;
  const missing = cum_missing;
  const denominator = reports + missing;
  return {
    available: true,
    today: {
      total: Number(hourlyRow.today_total) || 0,
      requests: Number(hourlyRow.today_requests) || 0,
    },
    cumulative: {
      total: cum_total,
      requests: cum_requests,
      reports,
      missing,
    },
    h24: {
      total: Number(hourlyRow.h24_total) || 0,
      requests: Number(hourlyRow.h24_requests) || 0,
    },
    d7: {
      total: Number(hourlyRow.d7_total) || 0,
      requests: Number(hourlyRow.d7_requests) || 0,
    },
    coverage: denominator === 0 ? null : reports / denominator,
  };
}

// Daily totals for the homepage activity heatmap: one row per UTC+8 day in
// [startDayIso, now]. Reads from token_usage_daily table (primary), with
// fallback to on-the-fly hourly derivation for the current UTC+8 day (to keep
// the "today" cell live) and full-range fallback if the daily table is not yet
// populated (rolling deploy safety). Returns a Map day -> { total, requests },
// or null when binding missing, or error object on failure.
export async function queryTokenDailySeries(env, startDayIso, now = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return null;
  const todayIso = isoDayUtc8(utc8DayStartUtcMs(now));
  const map = new Map();
  let dailyRows = [];
  let dailyTableHasData = false;

  // Try to read from token_usage_daily table first.
  try {
    const res = await d1.prepare(
      `SELECT day, input_tokens, output_tokens, total_tokens, requests, usage_reports, usage_missing
       FROM ${TABLE_DAILY}
       WHERE day >= ?
       ORDER BY day`
    ).bind(startDayIso).all();
    dailyRows = Array.isArray(res?.results) ? res.results : [];
    dailyTableHasData = dailyRows.length > 0;
  } catch (e) {
    // Table may not exist yet (migration pending) — fall back to hourly.
    dailyRows = [];
    dailyTableHasData = false;
  }

  // Populate map from daily table rows.
  for (const r of dailyRows) {
    if (!r || typeof r.day !== 'string') continue;
    map.set(r.day, {
      total: Number(r.total_tokens) || 0,
      requests: Number(r.requests) || 0,
    });
  }

  // If the current UTC+8 day is in range, overlay live hourly data for "today"
  // to keep the heatmap cell fresh (daily table is only refreshed by cron).
  if (todayIso >= startDayIso) {
    const todayStart = normalizeHour(utc8DayStartUtcMs(now));
    try {
      const res = await d1.prepare(
        `SELECT hour, COALESCE(SUM(total_tokens),0) AS total, COALESCE(SUM(requests),0) AS requests
         FROM ${TABLE}
         WHERE hour >= ?
         GROUP BY hour`
      ).bind(todayStart).all();
      const rows = Array.isArray(res?.results) ? res.results : [];
      let todayTotal = 0, todayRequests = 0;
      for (const r of rows) {
        todayTotal += Number(r.total) || 0;
        todayRequests += Number(r.requests) || 0;
      }
      if (todayTotal > 0 || todayRequests > 0) {
        map.set(todayIso, { total: todayTotal, requests: todayRequests });
      }
    } catch (e) {
      // Hourly overlay failed; keep daily table value if present.
    }
  }

  // If daily table had no data at all (pre-backfill or table missing), fall back
  // to full hourly derivation for the entire range — maintains heatmap during
  // rolling deploy before cron backfills. Skip todayIso (handled by overlay).
  if (!dailyTableHasData) {
    try {
      const startUtcMs = Date.parse(`${startDayIso}T00:00:00Z`) - DISPLAY_TIMEZONE_OFFSET_MS;
      const startHour = normalizeHour(startUtcMs);
      const res = await d1.prepare(
        `SELECT hour, COALESCE(SUM(total_tokens),0) AS total, COALESCE(SUM(requests),0) AS requests
         FROM ${TABLE}
         WHERE hour >= ?
         GROUP BY hour`
      ).bind(startHour).all();
      const rows = Array.isArray(res?.results) ? res.results : [];
      for (const r of rows) {
        if (!r || typeof r.hour !== 'string') continue;
        const ms = Date.parse(r.hour);
        if (!Number.isFinite(ms)) continue;
        const day = new Date(ms + DISPLAY_TIMEZONE_OFFSET_MS).toISOString().slice(0, 10);
        if (day < startDayIso) continue;
        // Skip todayIso — it's handled by the live hourly overlay above.
        if (day === todayIso) continue;
        const cur = map.get(day) || { total: 0, requests: 0 };
        map.set(day, {
          total: cur.total + (Number(r.total) || 0),
          requests: cur.requests + (Number(r.requests) || 0),
        });
      }
    } catch (e) {
      return { available: false, error: `queryTokenDailySeries: ${e?.message || e}` };
    }
  }

  return map;
}

// Per-model totals for the homepage's "模型使用 · 近 7 天" panel.
// Rolls up the last `days` × 24 hours from token_usage_model_hourly, grouped
// by model. Sorted by total tokens desc. Returns an array of
// { model, total, requests } rows, or an error object { available: false,
// error } when the binding is missing or the query fails (fail-open).
export async function queryTokenModelUsage(env, days = 7, now = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return { available: false, error: 'TOKEN_STATS_DB binding missing' };
  const startHour = normalizeHour(now - days * DAY_MS);
  try {
    const res = await d1.prepare(
      `SELECT model,
              COALESCE(SUM(total_tokens), 0) AS total,
              COALESCE(SUM(requests), 0) AS requests
       FROM ${TABLE_MODEL}
       WHERE hour >= ?
       GROUP BY model
       ORDER BY total DESC`,
    ).bind(startHour).all();
    const rows = Array.isArray(res?.results) ? res.results : [];
    return {
      available: true,
      rows: rows
        .filter((r) => r && typeof r.model === 'string' && r.model.length > 0)
        .map((r) => ({
          model: r.model,
          total: Number(r.total) || 0,
          requests: Number(r.requests) || 0,
        })),
    };
  } catch (e) {
    return { available: false, error: `queryTokenModelUsage: ${e?.message || e}` };
  }
}

// Recent-success evidence for the Public Model Status layer
// (src/runtime/model-status.js). Returns a Set<string> of logical model
// names that have at least one request in the per-model hourly aggregate
// within the last `windowMs` milliseconds.
//
// `requests > 0` is the success-evidence signal: the per-model table is
// written exactly once per delivered response (success or
// interrupted-with-usage) by persistTokenUsage(), so a row with requests > 0
// in the recent window means the model successfully completed at least one
// real request in that hour. A failed upstream that never delivered a
// response never reaches persistTokenUsage() and therefore never increments
// the counter — exactly the "recent successful evidence" signal we want.
//
// One single GROUP BY query reads every model in the window. The result is
// aggregated in-memory into a Set so the caller's per-model lookup is O(1).
//
// Fail-open contract (same as every other query in this module):
//   * Missing binding → empty Set (Public Model Status falls back to
//     runtime-only evidence; a fresh isolate then reports `unobserved`,
//     never `unavailable` for every model).
//   * Query failure → empty Set + the error is swallowed (the dashboard
//     keeps serving 200).
//   * NEVER fabricates evidence — an empty Set is "no evidence", not
//     "evidence of failure".
export async function queryRecentModelEvidence(env, windowMs = 24 * HOUR_MS, now = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return new Set();
  const startHour = normalizeHour(now - windowMs);
  try {
    const res = await d1.prepare(
      `SELECT model
       FROM ${TABLE_MODEL}
       WHERE hour >= ? AND requests > 0
       GROUP BY model`,
    ).bind(startHour).all();
    const rows = Array.isArray(res?.results) ? res.results : [];
    const out = new Set();
    for (const r of rows) {
      if (r && typeof r.model === 'string' && r.model.length > 0) out.add(r.model);
    }
    return out;
  } catch (e) {
    // Fail-open: no evidence. Public Model Status then falls back to the
    // runtime-only signal; a fresh isolate with no runtime state reports
    // `unobserved`, never `unavailable` for every model.
    return new Set();
  }
}

// Query TTFT percentiles from the histogram buckets for a given model.
// Returns:
//   { available: true, p50: <bucket upper bound ms>, p95: <bucket upper bound ms>,
//     sampleCount: <number>, insufficient: <boolean> }
// or { available: false, error } when the binding is missing or the query fails.
//
// Percentiles are computed from coarse-grained histogram buckets (b0..b6).
// The returned value is the UPPER BOUND of the bucket containing the percentile.
// For example, if P50 falls in the 1–2s bucket, p50 is reported as 2000 (not
// a fake precise value like 1.382s). This matches the bucket precision contract.
//
// Minimum sample threshold: 5 successful TTFT samples are needed for meaningful
// percentiles. Below that, `insufficient: true` is returned so the dashboard
// can display "样本不足" instead of misleading numbers.
export async function queryModelTtftPercentiles(env, model, days = 7, now = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return { available: false, error: 'TOKEN_STATS_DB binding missing' };
  if (typeof model !== 'string' || model.length === 0) return { available: false, error: 'model required' };
  const startHour = normalizeHour(now - days * DAY_MS);
  try {
    const res = await d1.prepare(
      `SELECT
        COALESCE(SUM(successful_ttft_count), 0) AS total_ttft,
        COALESCE(SUM(ttft_b0), 0) AS b0,
        COALESCE(SUM(ttft_b1), 0) AS b1,
        COALESCE(SUM(ttft_b2), 0) AS b2,
        COALESCE(SUM(ttft_b3), 0) AS b3,
        COALESCE(SUM(ttft_b4), 0) AS b4,
        COALESCE(SUM(ttft_b5), 0) AS b5,
        COALESCE(SUM(ttft_b6), 0) AS b6
       FROM ${TABLE_MODEL}
       WHERE hour >= ? AND model = ?`,
    ).bind(startHour, model).first();
    if (!res || typeof res !== 'object') return { available: false, error: 'no data' };
    const total = Number(res.total_ttft) || 0;
    if (total < 5) return { available: true, p50: null, p95: null, sampleCount: total, insufficient: true };
    const buckets = [
      Number(res.b0) || 0,
      Number(res.b1) || 0,
      Number(res.b2) || 0,
      Number(res.b3) || 0,
      Number(res.b4) || 0,
      Number(res.b5) || 0,
      Number(res.b6) || 0,
    ];
    const p50 = percentileFromBuckets(buckets, total, 0.5);
    const p95 = percentileFromBuckets(buckets, total, 0.95);
    return { available: true, p50, p95, sampleCount: total, insufficient: false };
  } catch (e) {
    return { available: false, error: `queryModelTtftPercentiles: ${e?.message || e}` };
  }
}

// Compute a percentile value from coarse histogram buckets.
// Returns the UPPER BOUND of the bucket containing the requested percentile.
// This matches the bucket precision contract — no fake precise values.
function percentileFromBuckets(buckets, total, pct) {
  const threshold = Math.ceil(total * pct);
  let cumulative = 0;
  for (let i = 0; i < buckets.length; i++) {
    cumulative += buckets[i];
    if (cumulative >= threshold) {
      // Return upper bound of this bucket (or ∞ for the last bucket)
      return i < TTFT_BUCKET_BOUNDARIES_MS.length ? TTFT_BUCKET_BOUNDARIES_MS[i] : Infinity;
    }
  }
  return Infinity;
}

// Query per-provider reliability stats (success rate) from token_usage_model_hourly.
// Returns per-model usage coverage: { model, requests, reports, missing, usageCoverage }.
// `usageCoverage` = reports / (reports + missing), null when no attributable requests.
// `reports` = delivered responses where upstream returned usage.
// `missing` = delivered responses where upstream did NOT return usage.
//
// Provider-agnostic: this query does not filter by provider — it returns aggregate
// per-model stats. Provider-specific filtering is NOT done here.
export async function queryModelUsageCoverage(env, days = 7, now = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return { available: false, error: 'TOKEN_STATS_DB binding missing' };
  const startHour = normalizeHour(now - days * DAY_MS);
  try {
    const res = await d1.prepare(
      `SELECT model,
              COALESCE(SUM(requests), 0) AS requests,
              COALESCE(SUM(usage_reports), 0) AS reports,
              COALESCE(SUM(usage_missing), 0) AS missing
       FROM ${TABLE_MODEL}
       WHERE hour >= ?
       GROUP BY model
       ORDER BY requests DESC`,
    ).bind(startHour).all();
    const rows = Array.isArray(res?.results) ? res.results : [];
    return {
      available: true,
      rows: rows
        .filter((r) => r && typeof r.model === 'string' && r.model.length > 0)
        .map((r) => {
          const requests = Number(r.requests) || 0;
          const reports = Number(r.reports) || 0;
          const missing = Number(r.missing) || 0;
          const denominator = reports + missing;
          return {
            model: r.model,
            requests,
            reports,
            missing,
            usageCoverage: denominator === 0 ? null : reports / denominator,
          };
        }),
    };
  } catch (e) {
    return { available: false, error: `queryModelUsageCoverage: ${e?.message || e}` };
  }
}

// Retention constants.
const HOURLY_RETENTION_DAYS = 7;
const DAILY_RETENTION_WEEKS = 52;
const WEEKLY_RETENTION_WEEKS = 52;

// ---- Aggregation: hourly → daily (idempotent, overwrite) ----
// Groups all hourly rows by their UTC+8 day and overwrites the daily table.
// Idempotent: running multiple times produces the same result.
export async function aggregateHourlyToDaily(env, now = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return { skipped: true, reason: 'TOKEN_STATS_DB binding missing' };
  try {
    // Read all hourly rows (bounded by 7-day retention; first run backfills all history).
    const res = await d1.prepare(
      `SELECT hour, input_tokens, output_tokens, total_tokens, requests, usage_reports, usage_missing
       FROM ${TABLE}`
    ).all();
    const rows = Array.isArray(res?.results) ? res.results : [];

    // Group by UTC+8 day.
    const byDay = new Map();
    for (const r of rows) {
      if (!r || typeof r.hour !== 'string') continue;
      const ms = Date.parse(r.hour);
      if (!Number.isFinite(ms)) continue;
      const day = isoDayUtc8(ms);
      const cur = byDay.get(day) || {
        input: 0, output: 0, total: 0, requests: 0, reports: 0, missing: 0,
      };
      byDay.set(day, {
        input: cur.input + (Number(r.input_tokens) || 0),
        output: cur.output + (Number(r.output_tokens) || 0),
        total: cur.total + (Number(r.total_tokens) || 0),
        requests: cur.requests + (Number(r.requests) || 0),
        reports: cur.reports + (Number(r.usage_reports) || 0),
        missing: cur.missing + (Number(r.usage_missing) || 0),
      });
    }

    // Bulk upsert (overwrite) all daily rows.
    const upsertStmt = d1.prepare(
      `INSERT INTO ${TABLE_DAILY} (day, input_tokens, output_tokens, total_tokens, requests, usage_reports, usage_missing)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         total_tokens = excluded.total_tokens,
         requests = excluded.requests,
         usage_reports = excluded.usage_reports,
         usage_missing = excluded.usage_missing`
    );
    const batch = [];
    for (const [day, v] of byDay) {
      batch.push(upsertStmt.bind(day, v.input, v.output, v.total, v.requests, v.reports, v.missing));
    }
    if (batch.length) await d1.batch(batch);
    return { aggregatedDays: batch.length };
  } catch (e) {
    console.error('aggregateHourlyToDaily failed:', e?.message || e);
    throw e;
  }
}

// ---- Aggregation: daily → weekly (idempotent, overwrite) ----
// Groups daily rows by their UTC week (Monday-start) and overwrites the weekly table.
// Idempotent: running multiple times produces the same result.
export async function aggregateDailyToWeekly(env, now = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return { skipped: true, reason: 'TOKEN_STATS_DB binding missing' };
  try {
    const res = await d1.prepare(
      `SELECT day, input_tokens, output_tokens, total_tokens, requests, usage_reports, usage_missing
       FROM ${TABLE_DAILY}`
    ).all();
    const rows = Array.isArray(res?.results) ? res.results : [];

    // Group by week_start (Monday of the week containing the UTC+8 day).
    const byWeek = new Map();
    for (const r of rows) {
      if (!r || typeof r.day !== 'string') continue;
      // Parse the UTC+8 day as a Date at noon UTC to get stable week bucket.
      const dayMs = Date.parse(r.day + 'T12:00:00Z');
      if (!Number.isFinite(dayMs)) continue;
      const weekStart = new Date(getUtcWeekStartUtcMs(dayMs)).toISOString().slice(0, 10);
      const cur = byWeek.get(weekStart) || {
        input: 0, output: 0, total: 0, requests: 0, reports: 0, missing: 0,
      };
      byWeek.set(weekStart, {
        input: cur.input + (Number(r.input_tokens) || 0),
        output: cur.output + (Number(r.output_tokens) || 0),
        total: cur.total + (Number(r.total_tokens) || 0),
        requests: cur.requests + (Number(r.requests) || 0),
        reports: cur.reports + (Number(r.usage_reports) || 0),
        missing: cur.missing + (Number(r.usage_missing) || 0),
      });
    }

    const upsertStmt = d1.prepare(
      `INSERT INTO ${TABLE_WEEKLY} (week_start, input_tokens, output_tokens, total_tokens, requests, usage_reports, usage_missing)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(week_start) DO UPDATE SET
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         total_tokens = excluded.total_tokens,
         requests = excluded.requests,
         usage_reports = excluded.usage_reports,
         usage_missing = excluded.usage_missing`
    );
    const batch = [];
    for (const [weekStart, v] of byWeek) {
      batch.push(upsertStmt.bind(weekStart, v.input, v.output, v.total, v.requests, v.reports, v.missing));
    }
    if (batch.length) await d1.batch(batch);
    return { aggregatedWeeks: batch.length };
  } catch (e) {
    console.error('aggregateDailyToWeekly failed:', e?.message || e);
    throw e;
  }
}

// ---- Unified retention cleanup ----
// Deletes expired rows from hourly, daily, and weekly tables.
// Order: aggregate first (handled by caller), then delete.
// Safe to run multiple times.
export async function cleanupUsageRetention(env, now = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return { skipped: true, reason: 'TOKEN_STATS_DB binding missing' };
  const results = {};

  // Hourly: delete rows older than 7 days.
  const hourlyCutoff = normalizeHour(now - HOURLY_RETENTION_DAYS * DAY_MS);
  try {
    const res = await d1.prepare(
      `DELETE FROM ${TABLE} WHERE hour < ?`
    ).bind(hourlyCutoff).run();
    results.hourly = { deleted: res?.meta?.changes ?? 0, cutoff: hourlyCutoff };
  } catch (e) {
    results.hourly = { error: e?.message || e };
  }

  // Daily: delete rows older than 52 weeks (aligned to heatmap grid).
  // The heatmap shows 52 weeks including the current week (currentWeekStart - 51 weeks).
  // We keep day >= (currentWeekStart - 51 weeks) == day >= weekStart(now) - 357 days.
  const currentWeekStart = getUtcWeekStartUtcMs(now);
  const dailyCutoffMs = currentWeekStart - (DAILY_RETENTION_WEEKS - 1) * WEEK_MS;
  const dailyCutoff = new Date(dailyCutoffMs).toISOString().slice(0, 10);
  try {
    const res = await d1.prepare(
      `DELETE FROM ${TABLE_DAILY} WHERE day < ?`
    ).bind(dailyCutoff).run();
    results.daily = { deleted: res?.meta?.changes ?? 0, cutoff: dailyCutoff };
  } catch (e) {
    results.daily = { error: e?.message || e };
  }

  // Weekly: delete rows older than 52 weeks (keep 52 completed weeks + current).
  // Keep week_start >= currentWeekStart - 51 weeks.
  const weeklyCutoffMs = currentWeekStart - (WEEKLY_RETENTION_WEEKS - 1) * WEEK_MS;
  const weeklyCutoff = new Date(weeklyCutoffMs).toISOString().slice(0, 10);
  try {
    const res = await d1.prepare(
      `DELETE FROM ${TABLE_WEEKLY} WHERE week_start < ?`
    ).bind(weeklyCutoff).run();
    results.weekly = { deleted: res?.meta?.changes ?? 0, cutoff: weeklyCutoff };
  } catch (e) {
    results.weekly = { error: e?.message || e };
  }

  console.log('token-stats retention cleanup:', JSON.stringify(results));
  return results;
}

// ---- Orchestrator: runs aggregations then cleanup ----
// Safe to run multiple times (idempotent). Fail-open for API path (called from cron).
export async function maintainUsageStats(env, now = Date.now()) {
  const aggDaily = await aggregateHourlyToDaily(env, now).catch(e => ({ error: e?.message || e }));
  const aggWeekly = await aggregateDailyToWeekly(env, now).catch(e => ({ error: e?.message || e }));
  const cleanup = await cleanupUsageRetention(env, now).catch(e => ({ error: e?.message || e }));
  return { aggDaily, aggWeekly, cleanup };
}

// ---- Backward compatibility: cleanupModelStats now delegates to unified cleanup ----
// Retention period for per-model stats (matches the dashboard's 7-day query window).
const MODEL_STATS_RETENTION_DAYS = 7;

export async function cleanupModelStats(env) {
  const d1 = tokenStatsD1(env);
  if (!d1) return { skipped: true, reason: 'TOKEN_STATS_DB binding missing' };
  const cutoffHour = normalizeHour(Date.now() - MODEL_STATS_RETENTION_DAYS * DAY_MS);
  try {
    const res = await d1.prepare(
      `DELETE FROM ${TABLE_MODEL} WHERE hour < ?`,
    ).bind(cutoffHour).run();
    const deleted = res?.meta?.changes ?? 0;
    console.log(`token-stats cleanup: deleted ${deleted} model-usage rows older than ${cutoffHour}`);
    return { deleted, cutoffHour };
  } catch (e) {
    console.error('token-stats cleanup failed:', e?.message || e);
    throw e;
  }
}
