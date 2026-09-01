#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Unit tests for Provider Dashboard observability semantics:
// - Usage Coverage (usage_reports / (usage_reports + usage_missing))
// - TTFT P50/P95 from successful requests only
// - Failure does NOT produce TTFT samples
// - Provider-agnostic: no provider-specific logic

import assert from 'node:assert/strict';
import { createMockD1 } from './mock-d1-database.mjs';
import {
  persistTokenUsage,
  queryModelUsageCoverage,
  queryModelTtftPercentiles,
  ttftBucketIndex,
  TTFT_BUCKET_BOUNDARIES_MS,
} from '../src/observability/token-usage-store.mjs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

// ─── ttftBucketIndex ────────────────────────────────────────────────────────

console.log('\n── ttftBucketIndex ──');

await test('negative value returns -1', () => {
  assert.equal(ttftBucketIndex(-1), -1);
});

await test('NaN returns -1', () => {
  assert.equal(ttftBucketIndex(NaN), -1);
});

await test('Infinity returns last bucket (6)', () => {
  assert.equal(ttftBucketIndex(Infinity), 6);
});

await test('0ms -> bucket 0 (< 100ms)', () => {
  assert.equal(ttftBucketIndex(0), 0);
});

await test('50ms -> bucket 0 (< 100ms)', () => {
  assert.equal(ttftBucketIndex(50), 0);
});

await test('99ms -> bucket 0 (< 100ms)', () => {
  assert.equal(ttftBucketIndex(99), 0);
});

await test('100ms -> bucket 1 (100-500ms)', () => {
  assert.equal(ttftBucketIndex(100), 1);
});

await test('300ms -> bucket 1 (100-500ms)', () => {
  assert.equal(ttftBucketIndex(300), 1);
});

await test('499ms -> bucket 1 (100-500ms)', () => {
  assert.equal(ttftBucketIndex(499), 1);
});

await test('500ms -> bucket 2 (500ms-1s)', () => {
  assert.equal(ttftBucketIndex(500), 2);
});

await test('999ms -> bucket 2 (500ms-1s)', () => {
  assert.equal(ttftBucketIndex(999), 2);
});

await test('1000ms -> bucket 3 (1-2s)', () => {
  assert.equal(ttftBucketIndex(1000), 3);
});

await test('1500ms -> bucket 3 (1-2s)', () => {
  assert.equal(ttftBucketIndex(1500), 3);
});

await test('2000ms -> bucket 4 (2-5s)', () => {
  assert.equal(ttftBucketIndex(2000), 4);
});

await test('4999ms -> bucket 4 (2-5s)', () => {
  assert.equal(ttftBucketIndex(4999), 4);
});

await test('5000ms -> bucket 5 (5-10s)', () => {
  assert.equal(ttftBucketIndex(5000), 5);
});

await test('9999ms -> bucket 5 (5-10s)', () => {
  assert.equal(ttftBucketIndex(9999), 5);
});

await test('10000ms -> bucket 6 (≥ 10s)', () => {
  assert.equal(ttftBucketIndex(10000), 6);
});

await test('30000ms -> bucket 6 (≥ 10s)', () => {
  assert.equal(ttftBucketIndex(30000), 6);
});

// ─── TTFT bucket boundaries constant ────────────────────────────────────────

console.log('\n── TTFT_BUCKET_BOUNDARIES_MS ──');

await test('has 6 boundaries', () => {
  assert.equal(TTFT_BUCKET_BOUNDARIES_MS.length, 6);
});

await test('boundaries are strictly increasing', () => {
  for (let i = 1; i < TTFT_BUCKET_BOUNDARIES_MS.length; i++) {
    assert.ok(TTFT_BUCKET_BOUNDARIES_MS[i] > TTFT_BUCKET_BOUNDARIES_MS[i - 1],
      `boundary ${i} (${TTFT_BUCKET_BOUNDARIES_MS[i]}) must be > ${i - 1} (${TTFT_BUCKET_BOUNDARIES_MS[i - 1]})`);
  }
});

// ─── persistTokenUsage with TTFT ────────────────────────────────────────────

console.log('\n── persistTokenUsage with TTFT ──');

await test('successful TTFT is recorded in histogram', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, 1000, 'model-a', 1500);
  const key = `${new Date(1000).toISOString().slice(0, 13)}:00:00Z|model-a`;
  const row = d1._modelRows.get(key);
  assert.ok(row, 'model row exists');
  assert.equal(row.successful_ttft_count, 1);
  assert.equal(row.ttft_b3, 1, '1500ms -> bucket 3 (1-2s)');
  assert.equal(row.ttft_b0, 0);
  assert.equal(row.ttft_b1, 0);
  assert.equal(row.ttft_b2, 0);
});

await test('null TTFT does not produce a sample', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, 1000, 'model-a', null);
  const key = `${new Date(1000).toISOString().slice(0, 13)}:00:00Z|model-a`;
  const row = d1._modelRows.get(key);
  assert.ok(row, 'model row exists');
  assert.equal(row.successful_ttft_count, 0);
  assert.equal(row.ttft_b0, 0);
  assert.equal(row.ttft_b3, 0);
});

await test('undefined TTFT does not produce a sample', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, 1000, 'model-a', undefined);
  const key = `${new Date(1000).toISOString().slice(0, 13)}:00:00Z|model-a`;
  const row = d1._modelRows.get(key);
  assert.ok(row, 'model row exists');
  assert.equal(row.successful_ttft_count, 0);
});

await test('multiple TTFT samples accumulate correctly', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
  await persistTokenUsage(env, usage, 1000, 'model-a', 50);    // bucket 0
  await persistTokenUsage(env, usage, 2000, 'model-a', 200);   // bucket 1
  await persistTokenUsage(env, usage, 3000, 'model-a', 1500);  // bucket 3
  await persistTokenUsage(env, usage, 4000, 'model-a', 6000);  // bucket 5
  const key = `${new Date(1000).toISOString().slice(0, 13)}:00:00Z|model-a`;
  const row = d1._modelRows.get(key);
  assert.ok(row, 'model row exists');
  assert.equal(row.successful_ttft_count, 4);
  assert.equal(row.ttft_b0, 1);
  assert.equal(row.ttft_b1, 1);
  assert.equal(row.ttft_b3, 1);
  assert.equal(row.ttft_b5, 1);
});

await test('no model -> no TTFT columns written', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, 1000, null, 1500);
  assert.equal(d1._modelRows.size, 0, 'no model rows written');
});

// ─── queryModelUsageCoverage ──────────────────────────────────────────────

console.log('\n── queryModelUsageCoverage ──');

await test('returns per-model usage coverage', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const now = Date.now();
  const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
  // model-a: 10 delivered with usage, 0 missing -> 100% coverage
  for (let i = 0; i < 10; i++) {
    await persistTokenUsage(env, usage, now - i * 1000, 'model-a');
  }
  // model-b: 1 delivered with usage, 9 delivered without usage -> 10% coverage
  await persistTokenUsage(env, usage, now, 'model-b');
  for (let i = 0; i < 9; i++) {
    await persistTokenUsage(env, null, now - (i + 1) * 1000, 'model-b');
  }
  const result = await queryModelUsageCoverage(env, 7, now);
  assert.equal(result.available, true);
  assert.ok(Array.isArray(result.rows));
  const a = result.rows.find((r) => r.model === 'model-a');
  const b = result.rows.find((r) => r.model === 'model-b');
  assert.ok(a, 'model-a found');
  assert.ok(b, 'model-b found');
  assert.equal(a.requests, 10);
  assert.equal(a.reports, 10);
  assert.equal(a.missing, 0);
  assert.equal(a.usageCoverage, 1);
  assert.equal(b.requests, 10);
  assert.equal(b.reports, 1);
  assert.equal(b.missing, 9);
  assert.equal(b.usageCoverage, 0.1);
});

await test('missing D1 binding returns available false', async () => {
  const result = await queryModelUsageCoverage({}, 7, Date.now());
  assert.equal(result.available, false);
});

await test('empty model returns empty rows', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const result = await queryModelUsageCoverage(env, 7, Date.now());
  assert.equal(result.available, true);
  assert.equal(result.rows.length, 0);
});

// ─── queryModelTtftPercentiles ──────────────────────────────────────────────

console.log('\n── queryModelTtftPercentiles ──');

await test('insufficient samples returns insufficient: true', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const now = Date.now();
  const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
  // Only 3 samples (< 5 threshold)
  for (let i = 0; i < 3; i++) {
    await persistTokenUsage(env, usage, now - i * 1000, 'model-a', 1000 + i * 500);
  }
  const result = await queryModelTtftPercentiles(env, 'model-a', 7, now);
  assert.equal(result.available, true);
  assert.equal(result.insufficient, true);
  assert.equal(result.sampleCount, 3);
  assert.equal(result.p50, null);
  assert.equal(result.p95, null);
});

await test('P50 and P95 are computed from histogram buckets', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const now = Date.now();
  const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
  // 10 samples: all in bucket 3 (1-2s)
  for (let i = 0; i < 10; i++) {
    await persistTokenUsage(env, usage, now - i * 1000, 'model-a', 1200);
  }
  const result = await queryModelTtftPercentiles(env, 'model-a', 7, now);
  assert.equal(result.available, true);
  assert.equal(result.insufficient, false);
  assert.equal(result.sampleCount, 10);
  // P50 and P95 both in bucket 3 -> upper bound is 2000ms
  assert.equal(result.p50, 2000);
  assert.equal(result.p95, 2000);
});

await test('P50 in bucket 2, P95 in bucket 4', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const now = Date.now();
  const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
  // 10 samples: 6 in bucket 2 (500ms-1s), 4 in bucket 4 (2-5s)
  for (let i = 0; i < 6; i++) {
    await persistTokenUsage(env, usage, now - i * 1000, 'model-a', 700);
  }
  for (let i = 0; i < 4; i++) {
    await persistTokenUsage(env, usage, now - (6 + i) * 1000, 'model-a', 3000);
  }
  const result = await queryModelTtftPercentiles(env, 'model-a', 7, now);
  assert.equal(result.available, true);
  assert.equal(result.insufficient, false);
  assert.equal(result.sampleCount, 10);
  // P50 (5th sample) is in bucket 2 -> upper bound 1000ms
  assert.equal(result.p50, 1000);
  // P95 (10th sample) is in bucket 4 -> upper bound 5000ms
  assert.equal(result.p95, 5000);
});

await test('missing model returns available false', async () => {
  const result = await queryModelTtftPercentiles({}, '', 7, Date.now());
  assert.equal(result.available, false);
});

await test('missing D1 binding returns available false', async () => {
  const result = await queryModelTtftPercentiles({}, 'model-a', 7, Date.now());
  assert.equal(result.available, false);
});

await test('no data returns available false', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const result = await queryModelTtftPercentiles(env, 'nonexistent', 7, Date.now());
  assert.equal(result.available, false);
});

// ─── Provider-agnostic verification ─────────────────────────────────────────

console.log('\n── Provider-agnostic verification ──');

await test('provider name does not affect usage coverage', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const now = Date.now();
  const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
  // provider-a: 10 delivered with usage
  for (let i = 0; i < 10; i++) {
    await persistTokenUsage(env, usage, now - i * 1000, 'model-a');
  }
  const result = await queryModelUsageCoverage(env, 7, now);
  assert.equal(result.available, true);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].usageCoverage, 1);
});

await test('new provider works without code changes', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const now = Date.now();
  const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
  // provider-new: 5 delivered with usage, 5 delivered without usage
  for (let i = 0; i < 5; i++) {
    await persistTokenUsage(env, usage, now - i * 1000, 'model-new');
  }
  for (let i = 0; i < 5; i++) {
    await persistTokenUsage(env, null, now - (5 + i) * 1000, 'model-new');
  }
  const result = await queryModelUsageCoverage(env, 7, now);
  assert.equal(result.available, true);
  const m = result.rows.find((r) => r.model === 'model-new');
  assert.ok(m, 'model-new found');
  assert.equal(m.usageCoverage, 0.5);
});

// ─── Core verification cases from task ──────────────────────────────────────

console.log('\n── Core verification cases ──');

await test('Provider A: 10 delivered with usage, TTFT 4s -> Usage Coverage 100%, P50 TTFT 4s', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const now = Date.now();
  const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
  for (let i = 0; i < 10; i++) {
    await persistTokenUsage(env, usage, now - i * 1000, 'provider-a', 4000);
  }
  const cov = await queryModelUsageCoverage(env, 7, now);
  const ttft = await queryModelTtftPercentiles(env, 'provider-a', 7, now);
  const a = cov.rows.find((r) => r.model === 'provider-a');
  assert.equal(a.usageCoverage, 1, 'Usage Coverage 100%');
  assert.equal(ttft.p50, 5000, 'P50 TTFT in 2-5s bucket -> 5000ms upper bound');
  assert.equal(ttft.sampleCount, 10);
});

await test('Provider B: 1 delivered with usage TTFT 500ms, 9 delivered without usage -> Usage Coverage 10%', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const now = Date.now();
  const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
  // 1 delivered with usage
  await persistTokenUsage(env, usage, now, 'provider-b', 500);
  // 9 delivered without usage (missing usage data)
  for (let i = 0; i < 9; i++) {
    await persistTokenUsage(env, null, now - (i + 1) * 1000, 'provider-b');
  }
  const cov = await queryModelUsageCoverage(env, 7, now);
  const ttft = await queryModelTtftPercentiles(env, 'provider-b', 7, now);
  const b = cov.rows.find((r) => r.model === 'provider-b');
  assert.equal(b.usageCoverage, 0.1, 'Usage Coverage 10%');
  // Only 1 TTFT sample (< 5 threshold) -> insufficient
  assert.equal(ttft.insufficient, true, 'insufficient samples');
  assert.equal(ttft.sampleCount, 1, 'only 1 TTFT sample');
  assert.equal(ttft.p50, null, 'P50 null when insufficient');
});

await test('fast failures do not pollute TTFT', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const now = Date.now();
  const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
  // 5 fast failures (delivered without usage) - should NOT produce TTFT samples
  for (let i = 0; i < 5; i++) {
    await persistTokenUsage(env, null, now - i * 1000, 'model-fast-fail');
  }
  // 5 slow successes (delivered with usage, 4s TTFT each)
  for (let i = 0; i < 5; i++) {
    await persistTokenUsage(env, usage, now - (5 + i) * 1000, 'model-fast-fail', 4000);
  }
  const cov = await queryModelUsageCoverage(env, 7, now);
  const ttft = await queryModelTtftPercentiles(env, 'model-fast-fail', 7, now);
  const m = cov.rows.find((r) => r.model === 'model-fast-fail');
  assert.equal(m.usageCoverage, 0.5, 'Usage Coverage 50%');
  assert.equal(ttft.sampleCount, 5, 'only 5 TTFT samples (failures excluded)');
  assert.equal(ttft.p50, 5000, 'P50 TTFT in 2-5s bucket');
});

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
