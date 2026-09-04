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
// Dashboard consumers (src/dashboard/pages.js):
//   queryTokenSummary     - rolling / today / cumulative / coverage
//   queryTokenDailySeries - 52-week heatmap
//   queryTokenModelUsage  - per-model usage
//   queryModelUsageCoverage - per-model usage coverage
//
// Public Model Status consumers (src/runtime/model-status.js):
//   queryRecentModelEvidence - recent successful traffic
//
// TTFT percentile consumer (src/dashboard/pages.js):
//   queryModelTtftPercentiles

import {
  TABLE, TABLE_MODEL, TABLE_TOTALS, TABLE_DAILY,
  HOUR_MS, DAY_MS,
  TTFT_BUCKET_BOUNDARIES_MS,
  normalizeHour, utc8DayStartUtcMs, isoDayUtc8,
  DISPLAY_TIMEZONE_OFFSET_MS,
  tokenStatsD1,
} from './keys.js';

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

// Daily totals for the homepage activity heatmap.
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

  // If the current UTC+8 day is in range, overlay live hourly data for
  // "today" to keep the heatmap cell fresh (daily table is only
  // refreshed by cron).
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

  // If daily table had no data at all (pre-backfill or table missing),
  // fall back to full hourly derivation for the entire range.
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
// (src/runtime/model-status.js). Returns a Set<string> of logical
// model names that have at least one request in the per-model hourly
// aggregate within the last `windowMs` milliseconds. `requests > 0`
// is the success-evidence signal: the per-model table is written
// exactly once per delivered response by persistTokenUsage(), so a
// row with requests > 0 in the recent window means the model
// successfully completed at least one real request in that hour.
// Fail-open: missing binding → empty Set, query failure → empty
// Set. NEVER fabricates evidence — an empty Set is "no evidence",
// not "evidence of failure".
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
    // Fail-open: no evidence. Public Model Status then falls back to
    // the runtime-only signal; a fresh isolate with no runtime state
    // reports `unobserved`, never `unavailable` for every model.
    return new Set();
  }
}

// Query TTFT percentiles from the histogram buckets for a given model.
// Returns the UPPER BOUND of the bucket containing the percentile
// (matching the bucket precision contract — no fake precise values).
// Minimum sample threshold: 5 successful TTFT samples are needed for
// meaningful percentiles. Below that, `insufficient: true` is
// returned so the dashboard can display "样本不足" instead of
// misleading numbers.
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

function percentileFromBuckets(buckets, total, pct) {
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
// stats. Provider-specific filtering is NOT done here.
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
