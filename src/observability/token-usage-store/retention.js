// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Token Usage Retention.
//
// Deletes expired rows from hourly, daily, weekly, and per-model
// tables. Order: aggregate first (caller's responsibility), then
// delete. Safe to run multiple times. The Cron Trigger
// (src/runtime/cron.js) calls maintainUsageStats() which chains
// the aggregation + cleanup passes.
//
// Retention windows are in `keys.js`:
//   HOURLY_RETENTION_MS  = 7 days
//   DAILY_RETENTION_MS   = 52 weeks
//   WEEKLY_RETENTION_MS  = 52 weeks
//   MODEL_STATS_RETENTION_DAYS = 7 (legacy, matches the dashboard's
//                                   7-day query window)

import { getUtcWeekStartUtcMs } from '../time-buckets.mjs';
import {
  TABLE, TABLE_MODEL, TABLE_DAILY, TABLE_WEEKLY,
  DAY_MS, WEEK_MS,
  HOURLY_RETENTION_MS, DAILY_RETENTION_MS, WEEKLY_RETENTION_MS,
  normalizeHour, tokenStatsD1,
} from './keys.js';

const HOURLY_RETENTION_DAYS = HOURLY_RETENTION_MS / DAY_MS;
const DAILY_RETENTION_WEEKS = DAILY_RETENTION_MS / WEEK_MS;
const WEEKLY_RETENTION_WEEKS = WEEKLY_RETENTION_MS / WEEK_MS;
const MODEL_STATS_RETENTION_DAYS = 7;

// ---- Unified retention cleanup ----
// Deletes expired rows from hourly, daily, and weekly tables.
// Order: aggregate first (handled by caller), then delete. Safe to
// run multiple times.
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

  // Daily: delete rows older than 52 weeks (aligned to heatmap
  // grid). The heatmap shows 52 weeks including the current week
  // (currentWeekStart - 51 weeks). We keep day >= (currentWeekStart
  // - 51 weeks) == day >= weekStart(now) - 357 days.
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

  // Weekly: delete rows older than 52 weeks (keep 52 completed
  // weeks + current). Keep week_start >= currentWeekStart - 51
  // weeks.
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

// ---- Legacy model cleanup (kept for backward compatibility) ----
// Retention period for per-model stats (matches the dashboard's
// 7-day query window).
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

// ---- Orchestrator: runs aggregations then cleanup ----
// Safe to run multiple times (idempotent). Fail-open for API path
// (called from cron). The model cleanup rejection is allowed to
// propagate so that Cron Trigger status reflects failures (matching
// legacy cleanupModelStats behavior).
export async function maintainUsageStats(env, now = Date.now()) {
  // Local import to avoid a circular reference: aggregation.js does
  // not need anything from retention.js, but the orchestrator
  // chains them. The dynamic import keeps the module graph a DAG.
  const { aggregateHourlyToDaily, aggregateDailyToWeekly } = await import('./aggregation.js');
  const aggDaily = await aggregateHourlyToDaily(env, now).catch(e => ({ error: e?.message || e }));
  const aggWeekly = await aggregateDailyToWeekly(env, now).catch(e => ({ error: e?.message || e }));
  const cleanup = await cleanupUsageRetention(env, now).catch(e => ({ error: e?.message || e }));
  const modelCleanup = await cleanupModelStats(env);
  return { aggDaily, aggWeekly, cleanup, modelCleanup };
}
