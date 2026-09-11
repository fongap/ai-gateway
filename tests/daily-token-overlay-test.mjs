#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Regression contract for the dashboard daily token series. Recent complete
// UTC+8 calendar days must be rebuilt from retained hourly rows so a stale
// daily cron snapshot cannot make yesterday's usage drop after midnight.

import assert from 'node:assert/strict';
import {
  persistTokenUsage,
  queryTokenDailySeries,
} from '../src/observability/token-usage-store.ts';
import { createMockD1 } from './mock-d1-database.mjs';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(error && error.stack || error);
    process.exitCode = 1;
  }
}

const HOUR = 3_600_000;

await test('recent seven full UTC+8 days override stale daily snapshots', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };

  // 2026-09-11 09:30 UTC+8. The hourly truth window is therefore
  // 2026-09-05 .. 2026-09-11 inclusive. 2026-09-04 must stay on daily.
  const now = Date.UTC(2026, 8, 11, 1, 30, 0);

  // Simulate the 09-10 daily snapshot having been materialized at 11:00,
  // before the rest of that day's traffic arrived.
  d1._dailyRows.set('2026-09-10', {
    input: 30, output: 0, total: 30, requests: 1, reports: 1, missing: 0,
  });
  // Older stable history must not be overwritten by a potentially partial
  // seventh-previous calendar day from rolling hourly retention.
  d1._dailyRows.set('2026-09-04', {
    input: 500, output: 0, total: 500, requests: 5, reports: 5, missing: 0,
  });

  // 09-10 UTC+8: 01:00, 12:00, 22:00 => full-day total 120.
  await persistTokenUsage(env, { prompt_tokens: 30, completion_tokens: 0 }, Date.UTC(2026, 8, 9, 17, 0, 0));
  await persistTokenUsage(env, { prompt_tokens: 40, completion_tokens: 0 }, Date.UTC(2026, 8, 10, 4, 0, 0));
  await persistTokenUsage(env, { prompt_tokens: 50, completion_tokens: 0 }, Date.UTC(2026, 8, 10, 14, 0, 0));

  // A 09-04 hourly row is deliberately present in the mock. It must not
  // replace the stable daily row because 09-04 is outside the seven FULL
  // calendar-day overlay window at this `now`.
  await persistTokenUsage(env, { prompt_tokens: 50, completion_tokens: 0 }, Date.UTC(2026, 8, 4, 4, 0, 0));

  const series = await queryTokenDailySeries(env, '2026-09-04', now);

  assert.equal(series.get('2026-09-10').total, 120, 'yesterday is rebuilt from all retained hourly rows');
  assert.equal(series.get('2026-09-10').requests, 3);
  assert.equal(series.get('2026-09-04').total, 500, 'older stable daily history is preserved');
});

await test('today is also rebuilt from hourly when a stale daily row exists', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const now = Date.UTC(2026, 8, 11, 1, 30, 0); // 09:30 UTC+8

  d1._dailyRows.set('2026-09-11', {
    input: 1, output: 0, total: 1, requests: 1, reports: 1, missing: 0,
  });
  await persistTokenUsage(env, { prompt_tokens: 20, completion_tokens: 0 }, Date.UTC(2026, 8, 11, 0, 0, 0));

  const series = await queryTokenDailySeries(env, '2026-09-11', now);
  assert.equal(series.get('2026-09-11').total, 20);
  assert.equal(series.get('2026-09-11').requests, 1);
});

await test('hourly remains the fallback when materialized daily history is absent', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const now = Date.UTC(2026, 8, 11, 1, 30, 0);
  const hour = Date.UTC(2026, 8, 10, 4, 0, 0); // 09-10 12:00 UTC+8

  await persistTokenUsage(env, { prompt_tokens: 12, completion_tokens: 0 }, hour);
  const series = await queryTokenDailySeries(env, '2026-09-01', now);

  assert.equal(series.get('2026-09-10').total, 12);
  assert.equal(series.get('2026-09-10').requests, 1);
});

if (!process.exitCode) console.log(`daily-token-overlay tests passed (${passed}).`);
else process.exit(1);
