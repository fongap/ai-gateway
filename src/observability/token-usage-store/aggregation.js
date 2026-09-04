// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Token Usage Aggregation.
//
// Reads from the hourly / daily tables and writes into the daily /
// weekly tables respectively. Idempotent: running either function
// multiple times produces the same result (overwrite, not increment).
//
// Cron Trigger (src/runtime/cron.js) calls maintainUsageStats() in
// retention.js, which chains the two aggregations + the cleanup
// passes. This module is the pure aggregation step; the cleanup
// step is a separate concern.

import { getUtcWeekStartUtcMs } from '../time-buckets.mjs';
import {
  TABLE, TABLE_DAILY, TABLE_WEEKLY,
  DAY_MS,
  normalizeHour, isoDayUtc8, tokenStatsD1,
} from './keys.js';

// ---- Aggregation: hourly → daily (idempotent, overwrite) ----
// Groups all hourly rows by their UTC+8 day and overwrites the daily
// table.
export async function aggregateHourlyToDaily(env, now = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return { skipped: true, reason: 'TOKEN_STATS_DB binding missing' };
  try {
    // Read all hourly rows (bounded by 7-day retention; first run
    // backfills all history).
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
// Groups daily rows by their UTC week (Monday-start) and overwrites
// the weekly table.
export async function aggregateDailyToWeekly(env, now = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return { skipped: true, reason: 'TOKEN_STATS_DB binding missing' };
  try {
    const res = await d1.prepare(
      `SELECT day, input_tokens, output_tokens, total_tokens, requests, usage_reports, usage_missing
       FROM ${TABLE_DAILY}`
    ).all();
    const rows = Array.isArray(res?.results) ? res.results : [];

    // Group by week_start (Monday of the week containing the UTC+8
    // day).
    const byWeek = new Map();
    for (const r of rows) {
      if (!r || typeof r.day !== 'string') continue;
      // Parse the UTC+8 day as a Date at noon UTC to get stable week
      // bucket.
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
