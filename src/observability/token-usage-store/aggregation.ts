// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Token Usage Aggregation.
//
// Both accounting views travel through the same hourly -> daily -> weekly
// materialization pipeline:
//   legacy columns   = successfully delivered responses
//   upstream_*       = physical upstream attempts
// This keeps retention/query behavior aligned without duplicating tables.

import { getUtcWeekStartUtcMs } from '../time-buckets.ts';
import {
  TABLE, TABLE_DAILY, TABLE_WEEKLY,
  isoDayUtc8, tokenStatsD1,
} from './keys.ts';
import type { D1PreparedStatement } from '../../types/cloudflare.ts';

type AggregateRow = {
  input: number, output: number, cacheCreation: number, cacheRead: number, total: number,
  requests: number, reports: number, missing: number,
  upstreamInput: number, upstreamOutput: number, upstreamCacheCreation: number, upstreamCacheRead: number,
  upstreamTotal: number, upstreamAttempts: number, upstreamReports: number, upstreamMissing: number,
};

function emptyAggregate(): AggregateRow {
  return {
    input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0,
    requests: 0, reports: 0, missing: 0,
    upstreamInput: 0, upstreamOutput: 0, upstreamCacheCreation: 0, upstreamCacheRead: 0,
    upstreamTotal: 0, upstreamAttempts: 0, upstreamReports: 0, upstreamMissing: 0,
  };
}

function addRow(cur: AggregateRow, r: Record<string, unknown>): AggregateRow {
  return {
    input: cur.input + (Number(r.input_tokens) || 0),
    output: cur.output + (Number(r.output_tokens) || 0),
    cacheCreation: cur.cacheCreation + (Number(r.cache_creation_input_tokens) || 0),
    cacheRead: cur.cacheRead + (Number(r.cache_read_input_tokens) || 0),
    total: cur.total + (Number(r.total_tokens) || 0),
    requests: cur.requests + (Number(r.requests) || 0),
    reports: cur.reports + (Number(r.usage_reports) || 0),
    missing: cur.missing + (Number(r.usage_missing) || 0),
    upstreamInput: cur.upstreamInput + (Number(r.upstream_input_tokens) || 0),
    upstreamOutput: cur.upstreamOutput + (Number(r.upstream_output_tokens) || 0),
    upstreamCacheCreation: cur.upstreamCacheCreation + (Number(r.upstream_cache_creation_input_tokens) || 0),
    upstreamCacheRead: cur.upstreamCacheRead + (Number(r.upstream_cache_read_input_tokens) || 0),
    upstreamTotal: cur.upstreamTotal + (Number(r.upstream_total_tokens) || 0),
    upstreamAttempts: cur.upstreamAttempts + (Number(r.upstream_attempts) || 0),
    upstreamReports: cur.upstreamReports + (Number(r.upstream_usage_reports) || 0),
    upstreamMissing: cur.upstreamMissing + (Number(r.upstream_usage_missing) || 0),
  };
}

export async function aggregateHourlyToDaily(env: Record<string, unknown>, now: number = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return { skipped: true, reason: 'TOKEN_STATS_DB binding missing' };
  try {
    const res = await d1.prepare(
      `SELECT hour,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens,
        requests, usage_reports, usage_missing,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing
       FROM ${TABLE}`
    ).all();
    const rows = Array.isArray(res?.results) ? res.results : [];

    const byDay = new Map<string, AggregateRow>();
    for (const r of rows) {
      if (!r || typeof r.hour !== 'string') continue;
      const ms = Date.parse(r.hour);
      if (!Number.isFinite(ms)) continue;
      const day = isoDayUtc8(ms);
      byDay.set(day, addRow(byDay.get(day) || emptyAggregate(), r));
    }

    const upsertStmt = d1.prepare(
      `INSERT INTO ${TABLE_DAILY} (
        day,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens,
        requests, usage_reports, usage_missing,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cache_creation_input_tokens = excluded.cache_creation_input_tokens,
         cache_read_input_tokens = excluded.cache_read_input_tokens,
         total_tokens = excluded.total_tokens,
         requests = excluded.requests,
         usage_reports = excluded.usage_reports,
         usage_missing = excluded.usage_missing,
         upstream_input_tokens = excluded.upstream_input_tokens,
         upstream_output_tokens = excluded.upstream_output_tokens,
         upstream_cache_creation_input_tokens = excluded.upstream_cache_creation_input_tokens,
         upstream_cache_read_input_tokens = excluded.upstream_cache_read_input_tokens,
         upstream_total_tokens = excluded.upstream_total_tokens,
         upstream_attempts = excluded.upstream_attempts,
         upstream_usage_reports = excluded.upstream_usage_reports,
         upstream_usage_missing = excluded.upstream_usage_missing`
    );
    const batch: D1PreparedStatement[] = [];
    for (const [day, v] of byDay) {
      batch.push(upsertStmt.bind(
        day,
        v.input, v.output, v.cacheCreation, v.cacheRead, v.total, v.requests, v.reports, v.missing,
        v.upstreamInput, v.upstreamOutput, v.upstreamCacheCreation, v.upstreamCacheRead, v.upstreamTotal,
        v.upstreamAttempts, v.upstreamReports, v.upstreamMissing,
      ));
    }
    if (batch.length) await d1.batch(batch);
    return { aggregatedDays: batch.length };
  } catch (e) {
    console.error('aggregateHourlyToDaily failed:', (e as { message?: unknown } | null | undefined)?.message || e);
    throw e;
  }
}

export async function aggregateDailyToWeekly(env: Record<string, unknown>, now: number = Date.now()) {
  const d1 = tokenStatsD1(env);
  if (!d1) return { skipped: true, reason: 'TOKEN_STATS_DB binding missing' };
  try {
    const res = await d1.prepare(
      `SELECT day,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens,
        requests, usage_reports, usage_missing,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing
       FROM ${TABLE_DAILY}`
    ).all();
    const rows = Array.isArray(res?.results) ? res.results : [];

    const byWeek = new Map<string, AggregateRow>();
    for (const r of rows) {
      if (!r || typeof r.day !== 'string') continue;
      const dayMs = Date.parse(r.day + 'T12:00:00Z');
      if (!Number.isFinite(dayMs)) continue;
      const weekStart = new Date(getUtcWeekStartUtcMs(dayMs)).toISOString().slice(0, 10);
      byWeek.set(weekStart, addRow(byWeek.get(weekStart) || emptyAggregate(), r));
    }

    const upsertStmt = d1.prepare(
      `INSERT INTO ${TABLE_WEEKLY} (
        week_start,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens,
        requests, usage_reports, usage_missing,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(week_start) DO UPDATE SET
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cache_creation_input_tokens = excluded.cache_creation_input_tokens,
         cache_read_input_tokens = excluded.cache_read_input_tokens,
         total_tokens = excluded.total_tokens,
         requests = excluded.requests,
         usage_reports = excluded.usage_reports,
         usage_missing = excluded.usage_missing,
         upstream_input_tokens = excluded.upstream_input_tokens,
         upstream_output_tokens = excluded.upstream_output_tokens,
         upstream_cache_creation_input_tokens = excluded.upstream_cache_creation_input_tokens,
         upstream_cache_read_input_tokens = excluded.upstream_cache_read_input_tokens,
         upstream_total_tokens = excluded.upstream_total_tokens,
         upstream_attempts = excluded.upstream_attempts,
         upstream_usage_reports = excluded.upstream_usage_reports,
         upstream_usage_missing = excluded.upstream_usage_missing`
    );
    const batch: D1PreparedStatement[] = [];
    for (const [weekStart, v] of byWeek) {
      batch.push(upsertStmt.bind(
        weekStart,
        v.input, v.output, v.cacheCreation, v.cacheRead, v.total, v.requests, v.reports, v.missing,
        v.upstreamInput, v.upstreamOutput, v.upstreamCacheCreation, v.upstreamCacheRead, v.upstreamTotal,
        v.upstreamAttempts, v.upstreamReports, v.upstreamMissing,
      ));
    }
    if (batch.length) await d1.batch(batch);
    return { aggregatedWeeks: batch.length };
  } catch (e) {
    console.error('aggregateDailyToWeekly failed:', (e as { message?: unknown } | null | undefined)?.message || e);
    throw e;
  }
}
