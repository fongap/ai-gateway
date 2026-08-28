#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Unit tests for the Cloudflare D1 token-usage store
// (src/observability/token-store.js): UTC hour normalization, per-response
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
  tokenStatsD1,
} from '../src/observability/token-store.js';
import { createMockD1 } from './d1-mock.mjs';

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
  assert.equal(d1._writes.length, 1);
  assert.match(d1._writes[0].sql, /ON CONFLICT\(hour\) DO UPDATE SET/);
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

await test('a D1 read failure makes queryTokenSummary return null, never throw', async () => {
  const d1 = createMockD1({ failReads: true });
  const s = await queryTokenSummary({ TOKEN_STATS_DB: d1 }, H0);
  assert.equal(s, null);
});

if (!process.exitCode) console.log(`\ntoken-store tests passed (${passed}).`);
else process.exit(1);
