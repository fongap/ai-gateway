// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Dashboard read path for PHYSICAL upstream-attempt usage. These queries never
// read delivered-response `requests` / `usage_reports`, so failures, fallback
// and hedge work can be shown without changing Public Model Status evidence.

import {
  TABLE, TABLE_MODEL, TABLE_TOTALS, TABLE_DAILY,
  HOUR_MS, DAY_MS,
  normalizeHour, normalizeModelKey, utc8DayStartUtcMs, isoDayUtc8,
  DISPLAY_TIMEZONE_OFFSET_MS,
  tokenStatsD1,
} from './keys.ts';

export type UpstreamDailyWindowRow = { total: number, requests: number, reports: number, missing: number };

const asMessage = (e: unknown): string => String((e as { message?: unknown } | null | undefined)?.message || e);

export async function queryUpstreamTokenSummary(env: Record<string, unknown>, now: number = Date.now()): Promise<{
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

  let totalsRow: Record<string, unknown> | null = null;
  try {
    totalsRow = await d1.prepare(
      `SELECT upstream_total_tokens, upstream_attempts, upstream_usage_reports, upstream_usage_missing
       FROM ${TABLE_TOTALS} WHERE scope = 'global'`
    ).first();
  } catch { /* rolling-deploy fallback below */ }

  let hourlyRow: Record<string, unknown> | null | undefined;
  try {
    hourlyRow = await d1.prepare(
      `SELECT
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_total_tokens END), 0) AS today_total,
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_attempts END), 0) AS today_attempts,
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_total_tokens END), 0) AS h24_total,
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_attempts END), 0) AS h24_attempts,
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_total_tokens END), 0) AS d7_total,
       COALESCE(SUM(CASE WHEN hour >= ? THEN upstream_attempts END), 0) AS d7_attempts
       FROM ${TABLE}`
    ).bind(todayStart, todayStart, h24Start, h24Start, d7Start, d7Start).first();
  } catch (e) {
    return { available: false, error: `queryUpstreamTokenSummary: ${asMessage(e)}` };
  }
  if (!hourlyRow || typeof hourlyRow !== 'object') return null;

  let total = 0, attempts = 0, reports = 0, missing = 0;
  if (totalsRow && typeof totalsRow === 'object') {
    total = Number(totalsRow.upstream_total_tokens) || 0;
    attempts = Number(totalsRow.upstream_attempts) || 0;
    reports = Number(totalsRow.upstream_usage_reports) || 0;
    missing = Number(totalsRow.upstream_usage_missing) || 0;
  } else {
    try {
      const fb = await d1.prepare(
        `SELECT COALESCE(SUM(upstream_total_tokens),0) AS t,
                COALESCE(SUM(upstream_attempts),0) AS a,
                COALESCE(SUM(upstream_usage_reports),0) AS rp,
                COALESCE(SUM(upstream_usage_missing),0) AS rm
         FROM ${TABLE}`
      ).first();
      total = Number(fb?.t) || 0;
      attempts = Number(fb?.a) || 0;
      reports = Number(fb?.rp) || 0;
      missing = Number(fb?.rm) || 0;
    } catch { /* fail-open zero cumulative; rolling values still usable */ }
  }

  const denominator = reports + missing;
  return {
    available: true,
    today: { total: Number(hourlyRow.today_total) || 0, requests: Number(hourlyRow.today_attempts) || 0 },
    h24: { total: Number(hourlyRow.h24_total) || 0, requests: Number(hourlyRow.h24_attempts) || 0 },
    d7: { total: Number(hourlyRow.d7_total) || 0, requests: Number(hourlyRow.d7_attempts) || 0 },
    cumulative: { total, requests: attempts, reports, missing },
    coverage: denominator === 0 ? null : reports / denominator,
  };
}

export async function queryUpstreamTokenDailySeries(env: Record<string, unknown>, startDayIso: string, now: number = Date.now()): Promise<Map<string, UpstreamDailyWindowRow> | { available: false, error: string } | null> {
  const d1 = tokenStatsD1(env);
  if (!d1) return null;
  const map = new Map<string, UpstreamDailyWindowRow>();
  let dailyRows: Record<string, unknown>[] = [];
  let dailyTableHasData = false;

  try {
    const res = await d1.prepare(
      `SELECT day, upstream_total_tokens, upstream_attempts, upstream_usage_reports, upstream_usage_missing
       FROM ${TABLE_DAILY}
       WHERE day >= ?
       ORDER BY day`
    ).bind(startDayIso).all();
    dailyRows = Array.isArray(res?.results) ? res.results : [];
    dailyTableHasData = dailyRows.length > 0;
  } catch {
    dailyRows = [];
  }

  for (const r of dailyRows) {
    if (!r || typeof r.day !== 'string') continue;
    map.set(r.day, {
      total: Number(r.upstream_total_tokens) || 0,
      requests: Number(r.upstream_attempts) || 0,
      reports: Number(r.upstream_usage_reports) || 0,
      missing: Number(r.upstream_usage_missing) || 0,
    });
  }

  const recentStartMs = utc8DayStartUtcMs(now) - 6 * DAY_MS;
  const recentStartIso = isoDayUtc8(recentStartMs);
  const hourlyStartDayIso = dailyTableHasData
    ? (startDayIso > recentStartIso ? startDayIso : recentStartIso)
    : startDayIso;
  const hourlyStartUtcMs = Date.parse(`${hourlyStartDayIso}T00:00:00Z`) - DISPLAY_TIMEZONE_OFFSET_MS;
  const hourlyStart = normalizeHour(hourlyStartUtcMs);

  try {
    const res = await d1.prepare(
      `SELECT hour,
              COALESCE(SUM(upstream_total_tokens),0) AS total,
              COALESCE(SUM(upstream_attempts),0) AS attempts,
              COALESCE(SUM(upstream_usage_reports),0) AS reports,
              COALESCE(SUM(upstream_usage_missing),0) AS missing
       FROM ${TABLE}
       WHERE hour >= ?
       GROUP BY hour`
    ).bind(hourlyStart).all();
    const rows = Array.isArray(res?.results) ? res.results : [];
    const hourlyByDay = new Map<string, UpstreamDailyWindowRow>();
    for (const r of rows) {
      if (!r || typeof r.hour !== 'string') continue;
      const ms = Date.parse(r.hour);
      if (!Number.isFinite(ms)) continue;
      const day = isoDayUtc8(ms);
      if (day < hourlyStartDayIso || day < startDayIso) continue;
      const cur = hourlyByDay.get(day) || { total: 0, requests: 0, reports: 0, missing: 0 };
      hourlyByDay.set(day, {
        total: cur.total + (Number(r.total) || 0),
        requests: cur.requests + (Number(r.attempts) || 0),
        reports: cur.reports + (Number(r.reports) || 0),
        missing: cur.missing + (Number(r.missing) || 0),
      });
    }
    for (const [day, value] of hourlyByDay) map.set(day, value);
  } catch (e) {
    if (!dailyTableHasData) return { available: false, error: `queryUpstreamTokenDailySeries: ${asMessage(e)}` };
  }
  return map;
}

export async function queryUpstreamTokenModelUsage(env: Record<string, unknown>, days: number = 7, now: number = Date.now()): Promise<{ available: true, rows: Array<{ model: string, total: number, requests: number }> } | { available: false, error: string }> {
  const d1 = tokenStatsD1(env);
  if (!d1) return { available: false, error: 'TOKEN_STATS_DB binding missing' };
  const startHour = normalizeHour(now - days * DAY_MS);
  try {
    const res = await d1.prepare(
      `SELECT LOWER(TRIM(model)) AS model,
              COALESCE(SUM(upstream_total_tokens), 0) AS total,
              COALESCE(SUM(upstream_attempts), 0) AS attempts
       FROM ${TABLE_MODEL}
       WHERE hour >= ?
       GROUP BY LOWER(TRIM(model))
       ORDER BY total DESC`
    ).bind(startHour).all();
    const rows = Array.isArray(res?.results) ? res.results : [];
    return {
      available: true,
      rows: rows
        .map((r) => ({ model: normalizeModelKey(r?.model), total: Number(r?.total) || 0, requests: Number(r?.attempts) || 0 }))
        .filter((r) => r.model.length > 0),
    };
  } catch (e) {
    return { available: false, error: `queryUpstreamTokenModelUsage: ${asMessage(e)}` };
  }
}
