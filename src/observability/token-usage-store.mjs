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

const TABLE = 'token_usage_hourly';
const TABLE_MODEL = 'token_usage_model_hourly';
const HOUR_MS = 3600_000;
const DAY_MS = 86400_000;

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
// failure does not roll back the global aggregate. Returns a Promise that
// settles once BOTH writes complete (or both are skipped due to missing
// binding); a single classified rejection surfaces through the catch in the
// caller, which guarantees at most one log entry per delivered response.
// May reject — the caller is responsible for fail-open handling.
export function persistTokenUsage(env, usage, now = Date.now(), model = null) {
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
    // A malformed/stub binding may throw synchronously from prepare/bind/run.
    // Convert that into the same asynchronous fail-open contract as a D1
    // promise rejection so it can never escape into the HTTP response path.
    return Promise.reject(persistFailure('global', cause));
  }
  if (typeof model !== 'string' || model.length === 0) {
    return globalTask.catch((cause) => { throw persistFailure('global', cause); });
  }
  let modelTask;
  try {
    modelTask = Promise.resolve(d1.prepare(
      `INSERT INTO ${TABLE_MODEL} (
        hour, model,
        input_tokens, output_tokens, total_tokens,
        requests, usage_reports, usage_missing
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour, model) DO UPDATE SET
        input_tokens = ${TABLE_MODEL}.input_tokens + excluded.input_tokens,
        output_tokens = ${TABLE_MODEL}.output_tokens + excluded.output_tokens,
        total_tokens = ${TABLE_MODEL}.total_tokens + excluded.total_tokens,
        requests = ${TABLE_MODEL}.requests + excluded.requests,
        usage_reports = ${TABLE_MODEL}.usage_reports + excluded.usage_reports,
        usage_missing = ${TABLE_MODEL}.usage_missing + excluded.usage_missing`,
    ).bind(
      hour, model,
      p.input, p.output, p.total,
      p.requests, p.reports, p.missing,
    ).run());
  } catch (cause) {
    modelTask = Promise.reject(cause);
  }
  return Promise.allSettled([globalTask, modelTask]).then(([globalResult, modelResult]) => {
    // Prefer the global aggregate failure when both writes fail: it is the
    // more important loss, and the request-level caller still emits exactly
    // one diagnostic. Promise.allSettled also observes both rejections, so no
    // secondary unhandled rejection can escape.
    if (globalResult.status === 'rejected') throw persistFailure('global', globalResult.reason);
    if (modelResult.status === 'rejected') throw persistFailure('per-model', modelResult.reason, model);
  });
}

function persistFailure(scope, cause, model = null) {
  const error = new Error(cause?.message || String(cause || 'D1 persistence failure'), { cause });
  error.name = 'TokenStatsPersistError';
  error.scope = scope;
  if (model) error.model = model;
  return error;
}

// Aggregate summary for the public dashboard in ONE query. Returns:
//   {
//     available: true,
//     today:      { total, requests },   // UTC+8 calendar day of `now`
//     cumulative: { total, requests, reports, missing },
//     h24: { total, requests },
//     d7:  { total, requests },
//     coverage: <number|null>,   // reports / (reports + missing), null when 0/0
//   }
// or null when the binding is missing or the query fails — the dashboard then
// renders "统计暂不可用" instead of a misleading 0. "今日" follows the UTC+8 day
// boundary (Beijing 00:00 = previous day 16:00Z), while h24/d7/cumulative are
// rolling UTC windows.
export async function queryTokenSummary(env, now = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return null;
  const todayStart = normalizeHour(utc8DayStartUtcMs(now));
  const h24Start = normalizeHour(now - 24 * HOUR_MS);
  const d7Start = normalizeHour(now - 7 * DAY_MS);
  const stmt = d1.prepare(
    `SELECT
      COALESCE(SUM(total_tokens), 0) AS cum_total,
      COALESCE(SUM(requests), 0) AS cum_requests,
      COALESCE(SUM(usage_reports), 0) AS cum_reports,
      COALESCE(SUM(usage_missing), 0) AS cum_missing,
      COALESCE(SUM(CASE WHEN hour >= ? THEN total_tokens END), 0) AS today_total,
      COALESCE(SUM(CASE WHEN hour >= ? THEN requests END), 0) AS today_requests,
      COALESCE(SUM(CASE WHEN hour >= ? THEN total_tokens END), 0) AS h24_total,
      COALESCE(SUM(CASE WHEN hour >= ? THEN requests END), 0) AS h24_requests,
      COALESCE(SUM(CASE WHEN hour >= ? THEN total_tokens END), 0) AS d7_total,
      COALESCE(SUM(CASE WHEN hour >= ? THEN requests END), 0) AS d7_requests
    FROM ${TABLE}`,
  );
  let row;
  try {
    row = await stmt.bind(todayStart, todayStart, h24Start, h24Start, d7Start, d7Start).first();
  } catch (e) {
    return { available: false, error: `queryTokenSummary: ${e?.message || e}` };
  }
  if (!row || typeof row !== 'object') return null;
  const reports = Number(row.cum_reports) || 0;
  const missing = Number(row.cum_missing) || 0;
  const denominator = reports + missing;
  return {
    available: true,
    today: {
      total: Number(row.today_total) || 0,
      requests: Number(row.today_requests) || 0,
    },
    cumulative: {
      total: Number(row.cum_total) || 0,
      requests: Number(row.cum_requests) || 0,
      reports,
      missing,
    },
    h24: {
      total: Number(row.h24_total) || 0,
      requests: Number(row.h24_requests) || 0,
    },
    d7: {
      total: Number(row.d7_total) || 0,
      requests: Number(row.d7_requests) || 0,
    },
    coverage: denominator === 0 ? null : reports / denominator,
  };
}

// Daily totals for the homepage activity heatmap: one row per UTC+8 day in
// [startDayIso, now], rolled up from the hourly buckets. `startDayIso` is a
// plain "YYYY-MM-DD" date in UTC+8. Returns a Map day -> { total, requests },
// or null when the binding is missing or the query fails (fail-open).
//
// The SQL groups by UTC hour (the storage granularity) using a simple
// substr() that is guaranteed to work on D1. The UTC+8 date conversion is
// done in the application layer — for each hourly bucket we compute the
// UTC+8 calendar date and aggregate. This avoids relying on D1's date()
// function which may not support column references with modifiers.
export async function queryTokenDailySeries(env, startDayIso, now = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return null;
  // Convert the UTC+8 start date to the UTC hour key at Beijing 00:00.
  // e.g. "2026-08-28" (UTC+8) -> "2026-08-27T16:00:00Z" (UTC)
  const startUtcMs = Date.parse(`${startDayIso}T00:00:00Z`) - DISPLAY_TIMEZONE_OFFSET_MS;
  const startHour = normalizeHour(startUtcMs);
  try {
    const res = await d1.prepare(
      `SELECT hour,
              COALESCE(SUM(total_tokens), 0) AS total,
              COALESCE(SUM(requests), 0) AS requests
       FROM ${TABLE}
       WHERE hour >= ?
       GROUP BY hour`,
    ).bind(startHour).all();
    const rows = Array.isArray(res?.results) ? res.results : [];
    const map = new Map();
    for (const r of rows) {
      if (!r || typeof r.hour !== 'string') continue;
      // Convert the UTC hour key to its UTC+8 calendar date
      const ms = Date.parse(r.hour);
      if (!Number.isFinite(ms)) continue;
      const day = new Date(ms + DISPLAY_TIMEZONE_OFFSET_MS).toISOString().slice(0, 10);
      const cur = map.get(day) || { total: 0, requests: 0 };
      map.set(day, {
        total: cur.total + (Number(r.total) || 0),
        requests: cur.requests + (Number(r.requests) || 0),
      });
    }
    return map;
  } catch (e) {
    return { available: false, error: `queryTokenDailySeries: ${e?.message || e}` };
  }
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

// Retention period for per-model stats (matches the dashboard's 7-day query window).
// The global token_usage_hourly table is NEVER pruned — it powers the cumulative
// KPIs on the public homepage and must retain all historical data.
const MODEL_STATS_RETENTION_DAYS = 7;

// Scheduled cleanup for the per-model hourly aggregate table.
// Runs via a cron trigger (configured by the operator in wrangler.jsonc).
// Deletes rows from token_usage_model_hourly older than MODEL_STATS_RETENTION_DAYS.
// Idempotent and safe to run multiple times — only touches the model table,
// never the global token_usage_hourly table.
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
