#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Unit tests for the Cloudflare D1 token-usage store
// (src/observability/token-usage-store.mjs): UTC hour normalization, per-response
// payload derivation, atomic UPSERT persistence (insert / same-hour upsert /
// different hours / reports / missing / requests / totals), the aggregate
// dashboard query (cumulative / 24h / 7d / coverage), and the fail-open
// contract (no binding, write rejection, read rejection — none may ever throw
// or fabricate tokens). Run directly.
import assert from 'node:assert/strict';
import {
  normalizeHour,
  tokenUsagePayload,
  persistTokenUsage,
  queryTokenSummary,
  queryTokenDailySeries,
  queryTokenModelUsage,
  cleanupModelStats,
  tokenStatsD1,
  utc8DayStartUtcMs,
  isoDayUtc8,
} from '../src/observability/token-usage-store.mjs';
import { createMockD1 } from './mock-d1-database.mjs';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

const HOUR = 3600_000;
const DAY = 86400_000;
const H0 = Math.floor(Date.now() / HOUR) * HOUR;

// ---- normalizeHour -----------------------------------------------------------

await test('normalizeHour produces a UTC-aligned YYYY-MM-DDTHH:00:00Z key', async () => {
  assert.equal(normalizeHour(new Date('2026-08-28T08:59:59Z')), '2026-08-28T08:00:00Z');
  assert.equal(normalizeHour(H0), new Date(H0).toISOString().slice(0, 13) + ':00:00Z');
  assert.equal(normalizeHour(new Date('2026-01-01T23:30:00Z')), '2026-01-01T23:00:00Z');
});

// ---- tokenUsagePayload (reported-vs-missing gate) ----------------------------

await test('reported usage yields a report payload with its token totals', async () => {
  assert.deepEqual(
    tokenUsagePayload({ prompt_tokens: 2, completion_tokens: 3 }),
    { input: 2, output: 3, total: 5, requests: 1, reports: 1, missing: 0 },
  );
  assert.deepEqual(
    tokenUsagePayload({ input_tokens: 4, output_tokens: 6 }),
    { input: 4, output: 6, total: 10, requests: 1, reports: 1, missing: 0 },
  );
});

await test('missing usage yields a missing payload and never fabricates tokens', async () => {
  for (const usage of [null, undefined, {}, [], 'x', 42]) {
    assert.deepEqual(
      tokenUsagePayload(usage),
      { input: 0, output: 0, total: 0, requests: 1, reports: 0, missing: 1 },
      String(usage),
    );
  }
});

// ---- persistTokenUsage: atomic hour-bucket UPSERT ---------------------------

await test('first insert creates the hour bucket and records the write', async () => {
  const d1 = createMockD1();
  await persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 2, completion_tokens: 8 }, H0);
  assert.deepEqual(
    d1._rows.get(normalizeHour(H0)),
    { input: 2, output: 8, total: 10, requests: 1, reports: 1, missing: 0 },
  );
  assert.equal(d1._writes.length, 2, 'global + totals writes');
  assert.match(d1._writes[0].sql, /ON CONFLICT\(hour\) DO UPDATE SET/);
  assert.match(d1._writes[1].sql, /token_usage_totals/i, 'second write is totals');
});

await test('same-hour upsert accumulates input/output/total/requests atomically', async () => {
  const d1 = createMockD1();
  await persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 2, completion_tokens: 3 }, H0);
  await persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 4, completion_tokens: 6 }, H0);
  assert.deepEqual(
    d1._rows.get(normalizeHour(H0)),
    { input: 6, output: 9, total: 15, requests: 2, reports: 2, missing: 0 },
  );
});

await test('different hours create separate buckets', async () => {
  const d1 = createMockD1();
  await persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 1, completion_tokens: 0 }, H0);
  await persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 0, completion_tokens: 2 }, H0 + HOUR);
  assert.equal(d1._rows.size, 2);
  assert.equal(d1._rows.get(normalizeHour(H0)).total, 1);
  assert.equal(d1._rows.get(normalizeHour(H0 + HOUR)).total, 2);
});

await test('missing usage bumps requests and usage_missing, never total_tokens', async () => {
  const d1 = createMockD1();
  await persistTokenUsage({ TOKEN_STATS_DB: d1 }, null, H0);
  await persistTokenUsage({ TOKEN_STATS_DB: d1 }, {}, H0);
  const row = d1._rows.get(normalizeHour(H0));
  assert.deepEqual(row, { input: 0, output: 0, total: 0, requests: 2, reports: 0, missing: 2 });
});

// ---- tokenStatsD1: binding detection ----------------------------------------

await test('tokenStatsD1 returns null when the binding is missing or not a D1', async () => {
  assert.equal(tokenStatsD1({}), null);
  assert.equal(tokenStatsD1({ TOKEN_STATS_DB: {} }), null);
  assert.equal(tokenStatsD1(undefined), null);
  const d1 = createMockD1();
  assert.equal(tokenStatsD1({ TOKEN_STATS_DB: d1 }), d1);
});

// ---- queryTokenSummary: cumulative / 24h / 7d / coverage --------------------

await test('no binding -> queryTokenSummary returns null (dashboard degrades)', async () => {
  assert.equal(await queryTokenSummary({}), null);
});

await test('cumulative, 24h and 7d windows sum the right buckets', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  // A at H0 (5) is current; B at H0-25h (10) inside 7d but outside 24h; C at
  // H0-9d (20) outside 7d. Query "now" just after A.
  await persistTokenUsage(env, { prompt_tokens: 5, completion_tokens: 0 }, H0);
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 0 }, H0 - 25 * HOUR);
  await persistTokenUsage(env, { prompt_tokens: 20, completion_tokens: 0 }, H0 - 9 * DAY);
  const s = await queryTokenSummary(env, H0 + HOUR);
  assert.equal(s.available, true);
  assert.equal(s.cumulative.total, 35);
  assert.equal(s.cumulative.requests, 3);
  // 24h window only contains A (B is >24h old).
  assert.equal(s.h24.total, 5);
  assert.equal(s.h24.requests, 1);
  // 7d window contains A + B (C is >7d old).
  assert.equal(s.d7.total, 15);
  assert.equal(s.d7.requests, 2);
});

await test('coverage is reports/(reports+missing), null at 0/0', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  await persistTokenUsage(env, { prompt_tokens: 1, completion_tokens: 1 }, H0);
  await persistTokenUsage(env, { prompt_tokens: 1, completion_tokens: 1 }, H0);
  await persistTokenUsage(env, { prompt_tokens: 1, completion_tokens: 1 }, H0);
  await persistTokenUsage(env, null, H0);
  const s = await queryTokenSummary(env, H0 + HOUR);
  assert.equal(s.cumulative.requests, 4);
  assert.equal(s.cumulative.reports, 3);
  assert.equal(s.cumulative.missing, 1);
  assert.equal(s.coverage, 0.75);
  assert.equal(s.h24.requests, 4);
  assert.equal(s.d7.requests, 4);
});

await test('today follows the UTC+8 day boundary (Beijing 00:00 = 16:00Z)', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  // H0 is the current hour; H0 - 24h is 24 hours before.
  // In UTC+8, they fall on different calendar days because they are exactly 24h apart.
  await persistTokenUsage(env, { prompt_tokens: 5, completion_tokens: 0 }, H0);
  await persistTokenUsage(env, { prompt_tokens: 7, completion_tokens: 0 }, H0 - 24 * HOUR);
  const s = await queryTokenSummary(env, H0 + HOUR / 2);
  assert.equal(s.today.total, 5, 'only the current UTC+8 day counts as today');
  assert.equal(s.today.requests, 1);
  assert.equal(s.cumulative.total, 12, 'cumulative still counts both days');
});

// ---- queryTokenDailySeries: daily rollup for the activity heatmap -----------

// Helper: convert UTC ms to UTC+8 date string (YYYY-MM-DD)
function toUtc8Day(ms) {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

await test('daily series groups hourly buckets by UTC+8 day', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  // Use fixed timestamps to ensure deterministic UTC+8 day boundaries.
  // 2026-08-29 00:00 UTC+8 = 2026-08-28T16:00:00Z
  const d0_00 = Date.UTC(2026, 7, 28, 16, 0, 0); // 2026-08-28T16:00:00Z = 2026-08-29 UTC+8
  const d0_01 = Date.UTC(2026, 7, 28, 17, 0, 0); // 2026-08-28T17:00:00Z = 2026-08-29 UTC+8 (same day)
  const d1_00 = Date.UTC(2026, 7, 27, 16, 0, 0); // 2026-08-27T16:00:00Z = 2026-08-28 UTC+8 (previous day)
  await persistTokenUsage(env, { prompt_tokens: 1, completion_tokens: 2 }, d0_00);
  await persistTokenUsage(env, { prompt_tokens: 3, completion_tokens: 4 }, d0_01);
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 0 }, d1_00);
  const day = '2026-08-29'; // UTC+8 day for d0_00 and d0_01
  const prevDay = '2026-08-28'; // UTC+8 day for d1_00
  const series = await queryTokenDailySeries(env, prevDay, d0_01 + HOUR);
  assert.equal(series.get(day).total, 10, 'two same UTC+8-day buckets roll up');
  assert.equal(series.get(day).requests, 2);
  assert.equal(series.get(prevDay).total, 10);
  // Days before the requested start are excluded.
  const strict = await queryTokenDailySeries(env, day, d0_01 + HOUR);
  assert.equal(strict.size, 1);
  assert.ok(strict.has(day));
});

await test('daily series fails open on missing binding or read errors', async () => {
  assert.equal(await queryTokenDailySeries({}, '2026-08-28'), null);
  const d1 = createMockD1({ failReads: true });
  const result = await queryTokenDailySeries({ TOKEN_STATS_DB: d1 }, '2026-08-28');
  assert.ok(result && result.available === false, 'returns error object on failure');
  assert.ok(result.error, 'error message present');
});

// ---- Fail-open contract -----------------------------------------------------

await test('persistTokenUsage with no binding resolves without touching D1', async () => {
  let called = false;
  const env = { TOKEN_STATS_DB: { prepare: () => { called = true; } } };
  // A non-D1-looking prepare is rejected by tokenStatsD1, so persistence skips.
  const res = await persistTokenUsage({}, { prompt_tokens: 1 });
  assert.equal(res, undefined);
  assert.equal(called, false);
});

await test('a D1 write rejection rejects the returned promise (caller swallows it)', async () => {
  const d1 = createMockD1({ failWrites: true });
  await assert.rejects(
    persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 1 }, H0),
    /mock D1 write failure/,
  );
});

await test('a synchronous D1 prepare failure is converted to a classified promise rejection', async () => {
  const d1 = { prepare() { throw new Error('mock synchronous prepare failure'); } };
  let failure;
  try {
    await persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 1 }, H0, 'test-model');
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.scope, 'global');
  assert.match(failure?.message || '', /mock synchronous prepare failure/);
});

await test('a D1 read failure makes queryTokenSummary return error object, never throw', async () => {
  const d1 = createMockD1({ failReads: true });
  const s = await queryTokenSummary({ TOKEN_STATS_DB: d1 }, H0);
  assert.ok(s && s.available === false, 'returns error object on failure');
  assert.ok(s.error, 'error message present');
});

// ---- queryTokenModelUsage: per-model 7-day rollup for the homepage panel ----

await test('queryTokenModelUsage fails open on missing binding', async () => {
  const r = await queryTokenModelUsage({}, 7, H0);
  assert.ok(r && r.available === false, 'returns error object on missing binding');
  assert.ok(r.error, 'error message present');
});

await test('queryTokenModelUsage aggregates per model and orders by total desc', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  // two writes for ultra (same hour), one for code-max, one for air (missing only)
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 20 }, H0, 'ultra');
  await persistTokenUsage(env, { prompt_tokens: 5, completion_tokens: 5 }, H0, 'ultra');
  await persistTokenUsage(env, { prompt_tokens: 100, completion_tokens: 0 }, H0, 'code-max');
  await persistTokenUsage(env, null, H0, 'air');
  const r = await queryTokenModelUsage(env, 7, H0 + HOUR);
  assert.equal(r.available, true);
  assert.equal(r.rows.length, 3, 'three distinct models');
  // code-max (100) > ultra (40) > air (0) — sorted desc
  assert.equal(r.rows[0].model, 'code-max');
  assert.equal(r.rows[0].total, 100);
  assert.equal(r.rows[0].requests, 1);
  assert.equal(r.rows[1].model, 'ultra');
  assert.equal(r.rows[1].total, 40);
  assert.equal(r.rows[1].requests, 2);
  assert.equal(r.rows[2].model, 'air');
  assert.equal(r.rows[2].total, 0);
  assert.equal(r.rows[2].requests, 1);
});

await test('queryTokenModelUsage excludes rows outside the requested window', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 0 }, H0, 'ultra');
  await persistTokenUsage(env, { prompt_tokens: 999, completion_tokens: 0 }, H0 - 8 * DAY, 'old-model');
  const r = await queryTokenModelUsage(env, 7, H0 + HOUR);
  assert.equal(r.rows.length, 1, 'only in-window model');
  assert.equal(r.rows[0].model, 'ultra');
});

await test('persistTokenUsage without model skips the per-model table write', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  await persistTokenUsage(env, { prompt_tokens: 1, completion_tokens: 1 }, H0);
  assert.equal(d1._modelRows.size, 0, 'no per-model rows when model is omitted');
  assert.equal(d1._rows.size, 1, 'global aggregate still written');
});

await test('per-model write failure is classified once and does not roll back global write', async () => {
  const d1 = createMockD1();
  const origPrepare = d1.prepare.bind(d1);
  d1.prepare = (sql) => {
    const stmt = origPrepare(sql);
    const origRun = stmt.run.bind(stmt);
    stmt.run = async (...args) => {
      if (/token_usage_model_hourly/i.test(sql)) throw new Error('mock per-model write failure');
      return origRun(...args);
    };
    return stmt;
  };
  let failure;
  try {
    await persistTokenUsage({ TOKEN_STATS_DB: d1 }, { prompt_tokens: 10, completion_tokens: 20 }, H0, 'test-model');
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.scope, 'per-model');
  assert.equal(failure?.model, 'test-model');
  assert.match(failure?.message || '', /mock per-model write failure/);
  assert.equal(d1._rows.size, 1, 'global aggregate still written despite per-model failure');
  assert.equal(d1._modelRows.size, 0, 'no per-model rows due to write failure');
});

await test('global write failure is the single classified rejection when both writes fail', async () => {
  const d1 = createMockD1({ failWrites: true });
  const env = { TOKEN_STATS_DB: d1 };
  // Global write fails -> promise rejects (caller catches and logs)
  await assert.rejects(
    persistTokenUsage(env, { prompt_tokens: 1 }, H0, 'test-model'),
    /mock D1 write failure/,
  );
  // Since global write failed, no rows should be written
  assert.equal(d1._rows.size, 0, 'no global rows when write fails');
  assert.equal(d1._modelRows.size, 0, 'no model rows when global write fails');
});

await test('cleanupModelStats deletes only per-model rows older than seven days', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  await persistTokenUsage(env, { prompt_tokens: 5 }, H0 - 8 * DAY, 'old-model');
  await persistTokenUsage(env, { prompt_tokens: 7 }, H0 - 6 * DAY, 'current-model');
  const originalNow = Date.now;
  Date.now = () => H0;
  try {
    const result = await cleanupModelStats(env);
    assert.equal(result.deleted, 1);
  } finally {
    Date.now = originalNow;
  }
  assert.equal(d1._modelRows.size, 1, 'only the retained model row remains');
  // Global hourly is now pruned by the unified cleanup (7-day retention).
  // This test only calls cleanupModelStats (legacy per-model cleanup), so
  // global rows remain. The unified cleanupUsageRetention would prune them.
  assert.equal(d1._rows.size, 2, 'global hourly unchanged by legacy cleanup');
});

await test('cleanupModelStats skips cleanly without a D1 binding', async () => {
  assert.deepEqual(await cleanupModelStats({}), {
    skipped: true,
    reason: 'TOKEN_STATS_DB binding missing',
  });
});

if (!process.exitCode) console.log(`\ntoken-usage-store tests passed (${passed}).`);
else process.exit(1);
