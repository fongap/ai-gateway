// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Token Usage Queries.
//
// All read paths from the D1 token-usage store. Every query in this
// module is fail-open: missing binding returns null/empty Set, query
// failure returns an { available: false, error } object so the
// dashboard can degrade gracefully. None of the queries throw into
// a request path.
//
// Dashboard consumers (src/dashboard/pages.ts):
//   queryTokenSummary     - rolling / today / cumulative / coverage
//   queryTokenDailySeries - 52-week heatmap
//   queryTokenModelUsage  - per-model usage
//   queryModelUsageCoverage - per-model usage coverage
//
// Public Model Status consumers (src/runtime/model-status.ts):
//   queryRecentModelEvidence - recent successful traffic
//
// TTFT percentile consumer (src/dashboard/pages.ts):
//   queryAllModelsTtftPercentiles

import {
  TABLE, TABLE_MODEL, TABLE_TOTALS, TABLE_DAILY,
  HOUR_MS, DAY_MS,
  normalizeHour, normalizeModelKey, utc8DayStartUtcMs, isoDayUtc8,
  DISPLAY_TIMEZONE_OFFSET_MS,
  tokenStatsD1,
} from './keys.ts';
import { TTFT_BUCKET_BOUNDARIES_MS } from './keys.ts';

type DailyWindowRow = { total: number, requests: number, reports: number, missing: number };
type TtftEntry = { available: true, p50: number | null, p95: number | null, sampleCount: number, p50Insufficient: boolean, p95Insufficient: boolean };

const asMessage = (e: unknown): string =>
  String((e as { message?: unknown } | null | undefined)?.message || e);

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
export async function queryTokenSummary(env: Record<string, unknown>, now: number = Date.now()): Promise<{
  available: true,
  today: { total: number, requests: number },
  h24: { total: number, requests: number },
  d7: { total: number, requests: number },
  cumulative: { total: number, requests: number, reports: number, missing: number },
  coverage: number | null,
} | { available: false, error: string } | null> {
  const d1 = tokenStatsD1(env);
  if (!d1) return null;
  const todayStart = normalizeHour(utc8DayStartUtcMs(now));
  const h24Start = normalizeHour(now - 24 * HOUR_MS);
  const d7Start = normalizeHour(now - 7 * DAY_MS);

  // First, try to read lifetime totals for cumulative KPIs.
  let totalsRow: Record<string, unknown> | null = null;
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
  let hourlyRow: Record<string, unknown> | null | undefined;
  try {
    hourlyRow = await hourlyStmt.bind(todayStart, todayStart, h24Start, h24Start, d7Start, d7Start).first();
  } catch (e) {
    return { available: false, error: `queryTokenSummary: ${asMessage(e)}` };
  }
  if (!hourlyRow || typeof hourlyRow !== 'object') return null;

  // Cumulative from totals (with hourly fallback for rolling-deploy safety).
  let cum_total: number, cum_requests: number, cum_reports: number, cum_missing: number;
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

// Daily totals for the homepage activity heatmap.
//
// Source-of-truth policy:
//   * the most recent 7 UTC+8 calendar days are rebuilt from hourly rows;
//   * older days come from the materialized daily table;
//   * when the daily table is absent/empty, hourly rows are used for every
//     retained day available in the requested range.
//
// Hourly retention is 7 rolling days. Rebuilding today + the previous six
// calendar days is therefore safe at every time of day: the oldest overlaid
// day still starts less than 7 * 24h before `now`. Never overlay the seventh
// previous calendar day because its early hours may already have been pruned.
export async function queryTokenDailySeries(env: Record<string, unknown>, startDayIso: string, now: number = Date.now()): Promise<Map<string, DailyWindowRow> | { available: false, error: string } | null> {
  const d1 = tokenStatsD1(env);
  if (!d1) return null;
  const map = new Map<string, DailyWindowRow>();
  let dailyRows: Record<string, unknown>[] = [];
  let dailyTableHasData = false;

  // Materialized history first. Recent retained days are overlaid below from
  // hourly, so a stale cron snapshot can never make a just-finished day jump
  // backwards after midnight.
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
    // Table may not exist yet (migration pending). Hourly becomes the only
    // available source below.
    dailyRows = [];
    dailyTableHasData = false;
  }

  for (const r of dailyRows) {
    if (!r || typeof r.day !== 'string') continue;
    map.set(r.day, {
      total: Number(r.total_tokens) || 0,
      requests: Number(r.requests) || 0,
      reports: Number(r.usage_reports) || 0,
      missing: Number(r.usage_missing) || 0,
    });
  }

  // Keep exactly seven FULL UTC+8 calendar days on the hourly truth path:
  // today plus the previous six days. If daily history is unavailable, query
  // from the caller's requested start instead and return whatever hourly
  // retention still contains.
  const recentStartMs = utc8DayStartUtcMs(now) - 6 * DAY_MS;
  const recentStartIso = isoDayUtc8(recentStartMs);
  const hourlyStartDayIso = dailyTableHasData
    ? (startDayIso > recentStartIso ? startDayIso : recentStartIso)
    : startDayIso;
  const hourlyStartUtcMs = Date.parse(`${hourlyStartDayIso}T00:00:00Z`) - DISPLAY_TIMEZONE_OFFSET_MS;
  const hourlyStart = normalizeHour(hourlyStartUtcMs);

  try {
    const res = await d1.prepare(
      `SELECT hour, COALESCE(SUM(total_tokens),0) AS total, COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(usage_reports),0) AS reports, COALESCE(SUM(usage_missing),0) AS missing
       FROM ${TABLE}
       WHERE hour >= ?
       GROUP BY hour`
    ).bind(hourlyStart).all();
    const rows = Array.isArray(res?.results) ? res.results : [];
    const hourlyByDay = new Map<string, DailyWindowRow>();

    for (const r of rows) {
      if (!r || typeof r.hour !== 'string') continue;
      const ms = Date.parse(r.hour);
      if (!Number.isFinite(ms)) continue;
      const day = isoDayUtc8(ms);
      if (day < hourlyStartDayIso || day < startDayIso) continue;
      const cur = hourlyByDay.get(day) || { total: 0, requests: 0, reports: 0, missing: 0 };
      hourlyByDay.set(day, {
        total: cur.total + (Number(r.total) || 0),
        requests: cur.requests + (Number(r.requests) || 0),
        reports: cur.reports + (Number(r.reports) || 0),
        missing: cur.missing + (Number(r.missing) || 0),
      });
    }

    // Hourly wins for every recent day it can prove. Older materialized rows
    // stay untouched, and an empty hourly result never fabricates a zero day.
    for (const [day, value] of hourlyByDay) map.set(day, value);
  } catch (e) {
    // With materialized history available, degrade to that snapshot rather
    // than failing the whole dashboard. Without daily history there is no
    // trustworthy source left, so preserve the existing fail-open contract.
    if (!dailyTableHasData) {
      return { available: false, error: `queryTokenDailySeries: ${asMessage(e)}` };
    }
  }

  return map;
}

// Per-model totals for the homepage's "模型使用 · 近 7 天" panel.
//
// Reader canonicalization: rows are grouped by LOWER(TRIM(model)) so
// historical case variants (Code-Max / code-max / CODE-MAX) merge into ONE
// stats dimension instead of splitting (or overwriting each other). The
// writer already canonicalizes; the reader must not depend on that —
// pre-normalization rows still exist in D1 until retention ages them out.
export async function queryTokenModelUsage(env: Record<string, unknown>, days: number = 7, now: number = Date.now()): Promise<{ available: true, rows: Array<{ model: string, total: number, requests: number }> } | { available: false, error: string }> {
  const d1 = tokenStatsD1(env);
  if (!d1) return { available: false, error: 'TOKEN_STATS_DB binding missing' };
  const startHour = normalizeHour(now - days * DAY_MS);
  try {
    const res = await d1.prepare(
      `SELECT LOWER(TRIM(model)) AS model,
              COALESCE(SUM(total_tokens), 0) AS total,
              COALESCE(SUM(requests), 0) AS requests
       FROM ${TABLE_MODEL}
       WHERE hour >= ?
       GROUP BY LOWER(TRIM(model))
       ORDER BY total DESC`,
    ).bind(startHour).all();
    const rows = Array.isArray(res?.results) ? res.results : [];
    return {
      available: true,
      rows: rows
        .map((r) => ({ model: normalizeModelKey(r?.model), total: Number(r?.total) || 0, requests: Number(r?.requests) || 0 }))
        .filter((r) => r.model.length > 0),
    };
  } catch (e) {
    return { available: false, error: `queryTokenModelUsage: ${asMessage(e)}` };
  }
}

// Recent Evidence window for the Public Model Status layer. This is the
// SINGLE definition of that window (24h): the runtime constant
// src/runtime/model-status.ts re-exports this binding, and every caller
// must pass it (or rely on this default) instead of hardcoding days.
export const MODEL_STATUS_RECENT_WINDOW_MS = 24 * HOUR_MS;

// Historical evidence window for the Public Model Status layer. This is the
// model-hourly retention window (7d): the per-model table is pruned by
// cleanupModelStats beyond that, so 7d is the maximum "has this model EVER
// served" lookback we can honestly answer. Used to distinguish 无新记录
// (recent window empty, history present) from 暂无记录 (no history at all).
export const MODEL_STATUS_HISTORICAL_WINDOW_MS = 7 * DAY_MS;

// Recent-success evidence for the Public Model Status layer
// (src/runtime/model-status.ts). Returns a Set<string> of canonical
// statistical model keys (trim + lowercase) that have at least one request
// in the per-model hourly aggregate within the last `windowMs` milliseconds.
// `requests > 0` is the success-evidence signal: the per-model table is
// written exactly once per delivered response by persistTokenUsage(), so a
// row with requests > 0 in the recent window means the model successfully
// completed at least one real request in that hour. The Set is canonical so
// callers can match official logical model IDs (Code-Max) against it via
// normalizeModelKey() without case drift. Fail-open: missing binding →
// empty Set, query failure → empty Set. NEVER fabricates evidence — an
// empty Set is "no evidence", not "evidence of failure".
export async function queryRecentModelEvidence(env: Record<string, unknown>, windowMs: number = MODEL_STATUS_RECENT_WINDOW_MS, now: number = Date.now()): Promise<Set<string>> {
  const d1 = tokenStatsD1(env);
  if (!d1) return new Set();
  const startHour = normalizeHour(now - windowMs);
  try {
    const res = await d1.prepare(
      `SELECT LOWER(TRIM(model)) AS model
       FROM ${TABLE_MODEL}
       WHERE hour >= ? AND requests > 0
       GROUP BY LOWER(TRIM(model))`,
    ).bind(startHour).all();
    const rows = Array.isArray(res?.results) ? res.results : [];
    const out = new Set<string>();
    for (const r of rows) {
      const key = normalizeModelKey(r?.model);
      if (key) out.add(key);
    }
    return out;
  } catch (e) {
    // Fail-open: no evidence. Public Model Status then falls back to
    // the runtime-only signal; a fresh isolate with no runtime state
    // reports `no_record`, never `down` for every model.
    return new Set();
  }
}

// Query TTFT histogram aggregates for ALL models in the window with ONE
// grouped D1 query, then compute percentiles in memory.
// The dashboard must not issue one query per model (N+1) nor limit TTFT
// visibility to Usage Top-N. Grouping is canonical (LOWER(TRIM(model))):
// historical case variants merge in SQL, so the in-memory pass cannot
// overwrite one variant's histogram with another's. Rows are keyed by the
// canonical statistical model key (trim + lowercase). Each entry:
//   { available: true, p50, p95, sampleCount, p50Insufficient, p95Insufficient }
//   samples < TTFT_P50_MIN_SAMPLES -> p50/p95 null, both insufficient
//   P50_MIN <= samples < P95_MIN   -> p50 set, p95 null (p95 insufficient)
//   samples >= P95_MIN             -> both set
// Percentiles are bucket-upper-bound precision (never a fabricated precise
// value); the last open bucket returns Infinity, which the dashboard renders
// as `>=10s`, never as a missing value. `windowMs` is an explicit millisecond
// window (the model-status section passes the 24h recent-evidence window).
export async function queryAllModelsTtftPercentiles(env: Record<string, unknown>, windowMs: number = MODEL_STATUS_RECENT_WINDOW_MS, now: number = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return { available: false, error: 'TOKEN_STATS_DB binding missing' };
  const startHour = normalizeHour(now - windowMs);
  try {
    const res = await d1.prepare(
      `SELECT LOWER(TRIM(model)) AS model,
              COALESCE(SUM(successful_ttft_count), 0) AS total_ttft,
              COALESCE(SUM(ttft_b0), 0) AS b0,
              COALESCE(SUM(ttft_b1), 0) AS b1,
              COALESCE(SUM(ttft_b2), 0) AS b2,
              COALESCE(SUM(ttft_b3), 0) AS b3,
              COALESCE(SUM(ttft_b4), 0) AS b4,
              COALESCE(SUM(ttft_b5), 0) AS b5,
              COALESCE(SUM(ttft_b6), 0) AS b6
       FROM ${TABLE_MODEL}
       WHERE hour >= ?
       GROUP BY LOWER(TRIM(model))`,
    ).bind(startHour).all();
    const rows = Array.isArray(res?.results) ? res.results : [];
    const ttft = new Map<string, TtftEntry>();
    for (const row of rows) {
      const key = normalizeModelKey(row?.model);
      if (!key) continue;
      const total = Number(row.total_ttft) || 0;
      if (total < TTFT_P50_MIN_SAMPLES) {
        ttft.set(key, { available: true, p50: null, p95: null, sampleCount: total, p50Insufficient: true, p95Insufficient: true });
        continue;
      }
      const buckets = [
        Number(row.b0) || 0,
        Number(row.b1) || 0,
        Number(row.b2) || 0,
        Number(row.b3) || 0,
        Number(row.b4) || 0,
        Number(row.b5) || 0,
        Number(row.b6) || 0,
      ];
      ttft.set(key, {
        available: true,
        p50: percentileFromBuckets(buckets, total, 0.5),
        p95: total >= TTFT_P95_MIN_SAMPLES ? percentileFromBuckets(buckets, total, 0.95) : null,
        sampleCount: total,
        p50Insufficient: false,
        p95Insufficient: total < TTFT_P95_MIN_SAMPLES,
      });
    }
    return { available: true, ttft };
  } catch (e) {
    return { available: false, error: `queryAllModelsTtftPercentiles: ${asMessage(e)}` };
  }
}

// Query TTFT percentiles from the histogram buckets for a given model.
// Returns the UPPER BOUND of the bucket containing the percentile
// (matching the bucket precision contract — no fake precise values).
// P50 and P95 have separate minimum sample thresholds: P50 needs 5
// samples, P95 needs 20 (the tail is far noisier, so the bar is higher).
// Below the P50 floor both percentiles are null; between the floors P50
// is reported and P95 stays null (dashboard tooltip: "P95 样本不足").
const TTFT_P50_MIN_SAMPLES = 5;
const TTFT_P95_MIN_SAMPLES = 20;

function percentileFromBuckets(buckets: number[], total: number, pct: number): number {
  const threshold = Math.ceil(total * pct);
  let cumulative = 0;
  for (let i = 0; i < buckets.length; i++) {
    cumulative += buckets[i];
    if (cumulative >= threshold) {
      // Return upper bound of this bucket (or Infinity for the last)
      return i < TTFT_BUCKET_BOUNDARIES_MS.length ? TTFT_BUCKET_BOUNDARIES_MS[i] : Infinity;
    }
  }
  return Infinity;
}

// Query per-model reliability stats from token_usage_model_hourly.
// Returns per-model usage coverage. Provider-agnostic: this query
// does not filter by provider — it returns aggregate per-model
// stats. Provider-specific filtering is NOT done here. Grouping is
// canonical (LOWER(TRIM(model))) so historical case variants merge
// instead of splitting requests / reports / missing across keys.
export async function queryModelUsageCoverage(env: Record<string, unknown>, days: number = 7, now: number = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return { available: false, error: 'TOKEN_STATS_DB binding missing' };
  const startHour = normalizeHour(now - days * DAY_MS);
  try {
    const res = await d1.prepare(
      `SELECT LOWER(TRIM(model)) AS model,
              COALESCE(SUM(requests), 0) AS requests,
              COALESCE(SUM(usage_reports), 0) AS reports,
              COALESCE(SUM(usage_missing), 0) AS missing
       FROM ${TABLE_MODEL}
       WHERE hour >= ?
       GROUP BY LOWER(TRIM(model))
       ORDER BY requests DESC`,
    ).bind(startHour).all();
    const rows = Array.isArray(res?.results) ? res.results : [];
    return {
      available: true,
      rows: rows
        .map((r) => {
          const requests = Number(r?.requests) || 0;
          const reports = Number(r?.reports) || 0;
          const missing = Number(r?.missing) || 0;
          const denominator = reports + missing;
          return {
            model: normalizeModelKey(r?.model),
            requests,
            reports,
            missing,
            usageCoverage: denominator === 0 ? null : reports / denominator,
          };
        })
        .filter((r) => r.model.length > 0),
    };
  } catch (e) {
    return { available: false, error: `queryModelUsageCoverage: ${asMessage(e)}` };
  }
}
