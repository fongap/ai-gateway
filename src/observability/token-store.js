// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Cloudflare D1 token-usage persistence: the ONLY cross-isolate / cross-PoP /
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
//     upstream-reported usage, normalized by src/observability/tokens.js.
//
// Invariant (verified independently of any isolate):
//   requests = usage_reports + usage_missing
// within the set of completed-and-entered-token-stats AI responses.
//
// The hot path (src/request/handler.js) only calls persistTokenUsage() inside
// ctx.waitUntil(); the dashboard (src/dashboard/pages.js) calls
// queryTokenSummary() and degrades to "统计暂不可用" on any failure.

import { normalizeTokenUsage } from './tokens.js';

const TABLE = 'token_usage_hourly';
const HOUR_MS = 3600_000;
const DAY_MS = 86400_000;

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
  return d1 && typeof d1.prepare === 'function' ? d1 : null;
}

// Atomic per-hour UPSERT. One call = one response; the hour bucket is
// incremented by a single SQL statement so two isolates updating the same hour
// never lose a count (no SELECT-then-UPDATE race). `usage` is the RAW upstream
// usage (or null/undefined); it is normalized here, so a report and a missing
// response each produce exactly one payload. Returns the D1 run promise, which
// may reject — the caller is responsible for fail-open handling.
export function persistTokenUsage(env, usage, now = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return Promise.resolve();
  const hour = normalizeHour(now);
  const p = tokenUsagePayload(usage);
  const stmt = d1.prepare(
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
  return stmt.bind(
    hour,
    p.input,
    p.output,
    p.total,
    p.requests,
    p.reports,
    p.missing,
  ).run();
}

// Aggregate summary for the public dashboard in ONE query. Returns:
//   {
//     available: true,
//     cumulative: { total, requests, reports, missing },
//     h24: { total, requests },
//     d7:  { total, requests },
//     coverage: <number|null>,   // reports / (reports + missing), null when 0/0
//   }
// or null when the binding is missing or the query fails — the dashboard then
// renders "统计暂不可用" instead of a misleading 0.
export async function queryTokenSummary(env, now = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return null;
  const h24Start = normalizeHour(now - 24 * HOUR_MS);
  const d7Start = normalizeHour(now - 7 * DAY_MS);
  const stmt = d1.prepare(
    `SELECT
      COALESCE(SUM(total_tokens), 0) AS cum_total,
      COALESCE(SUM(requests), 0) AS cum_requests,
      COALESCE(SUM(usage_reports), 0) AS cum_reports,
      COALESCE(SUM(usage_missing), 0) AS cum_missing,
      COALESCE(SUM(CASE WHEN hour >= ? THEN total_tokens END), 0) AS h24_total,
      COALESCE(SUM(CASE WHEN hour >= ? THEN requests END), 0) AS h24_requests,
      COALESCE(SUM(CASE WHEN hour >= ? THEN total_tokens END), 0) AS d7_total,
      COALESCE(SUM(CASE WHEN hour >= ? THEN requests END), 0) AS d7_requests
    FROM ${TABLE}`,
  );
  let row;
  try {
    row = await stmt.bind(h24Start, h24Start, d7Start, d7Start).first();
  } catch {
    return null; // fail-open: page degrades, never 500s
  }
  if (!row || typeof row !== 'object') return null;
  const reports = Number(row.cum_reports) || 0;
  const missing = Number(row.cum_missing) || 0;
  const denominator = reports + missing;
  return {
    available: true,
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
