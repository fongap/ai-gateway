#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Observability Canonicalization Contract — historical case variants.
//
// The writer (persistTokenUsage) canonicalizes every new model key
// (trim + lowercase), so tests that only go through the writer can never
// observe the historical-data problem: real D1 still contains rows written
// before canonicalization (Code-Max / CODE-MAX / padded strings). This
// contract seeds RAW case-variant rows directly into the simulated table
// (bypassing the writer) and pins the reader-side merge semantics:
//
//   C01  Token Usage: variants merge into ONE canonical row (summed
//        total / requests), never split dimensions.
//   C02  TTFT: variant histograms merge BEFORE percentile computation —
//        no Map overwrite, sampleCount is the true sum, p50/p95 come from
//        the merged buckets.
//   C03  Recent Evidence: only the canonical key is returned.
//   C04  Usage Coverage: requests / reports / missing merge; coverage is
//        computed from the merged numbers.
//   C05  Writer/reader double insurance: writer canonical output is
//        unaffected (persist + read still yields the canonical key).
//
// The 24h evidence window and the TTFT precision contracts live in their
// own suites (model-status-window-contract-test / ttft-query-contract-test).

import assert from 'node:assert/strict';
import {
  queryTokenModelUsage,
  queryRecentModelEvidence,
  queryAllModelsTtftPercentiles,
  queryModelUsageCoverage,
  persistTokenUsage,
} from '../src/observability/token-usage-store.ts';
import { createMockD1 } from './mock-d1-database.mjs';

const HOUR = 3_600_000;
const now = () => 1_700_000_000_000;
const h0 = Math.floor((now() - 30 * 60_000) / HOUR) * HOUR; // 30 min ago

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ---- C01: Token Usage merges historical case variants -------------------------
{
  const d1 = createMockD1();
  // Historical rows exactly as they might exist in D1 today: pre-canonical
  // writes with mixed case (and one padded with spaces — TRIM handles it).
  d1.seedModelRow(h0, 'Code-Max', { total: 100, requests: 2 });
  d1.seedModelRow(h0 - HOUR, 'code-max', { total: 50, requests: 1 });
  d1.seedModelRow(h0 - 2 * HOUR, 'CODE-MAX', { total: 25, requests: 1 });
  d1.seedModelRow(h0 - 3 * HOUR, ' Code-Max ', { total: 10, requests: 1 });
  const env = { TOKEN_STATS_DB: d1 };
  const res = await queryTokenModelUsage(env, 7, now());
  check('C01 variants produce exactly ONE canonical stats dimension',
    res.available === true && res.rows.length === 1 && res.rows[0].model === 'code-max',
    `rows=${JSON.stringify(res.rows)}`);
  check('C01 totals and requests are the true sums across variants',
    res.rows.length === 1 && res.rows[0].total === 185 && res.rows[0].requests === 5,
    `rows=${JSON.stringify(res.rows)}`);
}

// ---- C02: TTFT histograms merge before percentiles (no Map overwrite) ---------
{
  const d1 = createMockD1();
  // Three case variants plus a second-hour row of one variant. With the
  // legacy GROUP BY model + JS map.set() the `code-max` entry would be
  // overwritten by whichever raw variant came last (sampleCount <= 9);
  // correct behavior merges all four rows: count = 3+3+3+9 = 18,
  // buckets b0=3, b1=3, b2=3, b4=9.
  d1.seedModelRow(h0, 'Code-Max', { successful_ttft_count: 3, ttft_b0: 3 });
  d1.seedModelRow(h0, 'code-max', { successful_ttft_count: 3, ttft_b1: 3 });
  d1.seedModelRow(h0 - HOUR, 'CODE-MAX', { successful_ttft_count: 3, ttft_b2: 3 });
  d1.seedModelRow(h0 - HOUR, 'code-max', { successful_ttft_count: 9, ttft_b4: 9 });
  const env = { TOKEN_STATS_DB: d1 };
  const res = await queryAllModelsTtftPercentiles(env, 7, now());
  const entry = res.ttft.get('code-max');
  check('C02 variants merge into one TTFT entry with the true sample count',
    res.available === true && res.ttft.size === 1 && entry && entry.sampleCount === 18,
    `keys=${JSON.stringify([...res.ttft.keys()])} entry=${JSON.stringify(entry)}`);
  // p50: ceil(18*0.5)=9th sample -> cumulative b0=3, b1=6, b2=9 -> bucket 2 (1000ms).
  // p95: ceil(18*0.95)=18th sample -> b3=0, b4=9 -> cumulative 18 at bucket 4 (5000ms).
  check('C02 percentiles are computed from the MERGED histogram (not the last variant)',
    entry && entry.insufficient === false && entry.p50 === 1000 && entry.p95 === 5000,
    `p50=${entry && entry.p50} p95=${entry && entry.p95}`);
}

// ---- C03: Recent Evidence returns only the canonical key ----------------------
{
  const d1 = createMockD1();
  d1.seedModelRow(h0, 'Code-Max', { requests: 2 });
  d1.seedModelRow(h0 - HOUR, 'CODE-MAX', { requests: 1 });
  d1.seedModelRow(h0 - 2 * HOUR, 'other-model', { requests: 1 });
  const env = { TOKEN_STATS_DB: d1 };
  const evidence = await queryRecentModelEvidence(env, undefined, now());
  check('C03 evidence contains only canonical keys',
    evidence.size === 2 && evidence.has('code-max') && evidence.has('other-model'),
    `evidence=${JSON.stringify([...evidence])}`);
}

// ---- C04: Usage Coverage merges requests / reports / missing ------------------
{
  const d1 = createMockD1();
  d1.seedModelRow(h0, 'Code-Max', { requests: 3, reports: 2, missing: 1 });
  d1.seedModelRow(h0 - HOUR, 'code-max', { requests: 2, reports: 1, missing: 1 });
  d1.seedModelRow(h0 - 2 * HOUR, 'CODE-MAX', { requests: 0, reports: 0, missing: 0 });
  const env = { TOKEN_STATS_DB: d1 };
  const res = await queryModelUsageCoverage(env, 7, now());
  const row = res.rows.find((r) => r.model === 'code-max');
  check('C04 coverage variants merge into one row with summed counts',
    res.rows.length === 1 && row && row.requests === 5 && row.reports === 3 && row.missing === 2,
    `rows=${JSON.stringify(res.rows)}`);
  check('C04 coverage ratio is computed from the merged numbers',
    row && row.usageCoverage !== null && Math.abs(row.usageCoverage - 0.6) < 1e-9,
    `usageCoverage=${row && row.usageCoverage}`);
}

// ---- C05: writer canonical output keeps working (double insurance) ------------
{
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'Code-Max', 400);
  await persistTokenUsage(env, { prompt_tokens: 1, completion_tokens: 1 }, h0, 'CODE-MAX', 400);
  const [usage, evidence] = await Promise.all([
    queryTokenModelUsage(env, 7, now()),
    queryRecentModelEvidence(env, undefined, now()),
  ]);
  check('C05 writer-canonicalized rows read back as one canonical dimension',
    usage.rows.length === 1 && usage.rows[0].model === 'code-max'
      && usage.rows[0].total === 17 && usage.rows[0].requests === 2
      && evidence.has('code-max'),
    `rows=${JSON.stringify(usage.rows)} evidence=${JSON.stringify([...evidence])}`);
}

if (failures > 0) {
  console.error(`model-stats-canonicalization: ${failures} contract(s) FAILED`);
  process.exit(1);
}
console.log('model-stats-canonicalization: all contracts passed');
