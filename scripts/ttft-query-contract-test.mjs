#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// TTFT Query Contract.
//
// Design facts pinned here: the dashboard's TTFT coverage must not depend on
// the Usage Top-N slice, and must not issue one D1 query per model (N+1). A
// single grouped query (GROUP BY model) returns histogram aggregates for all
// models in the window; percentiles are computed in memory with bucket-upper-
// bound precision. A previous regression only gave TTFT to the Usage Top 4
// models via per-model queries.
//
//   C01  Every public model gets a TTFT result container (missing rows ->
//        insufficient/noSamples), never a missing key.
//   C02  Query count is fixed: 1 grouped TTFT query regardless of model count.
//   C03  Model keys are canonical (trim + lowercase): Code-Max / code-max /
//        CODE-MAX aggregate into one stats dimension.
//   C04  Below the minimum sample threshold: p50 = null, p95 = null,
//        insufficient = true.
//   C05  Percentiles are bucket UPPER BOUNDS (no fabricated precision).

import assert from 'node:assert/strict';
import {
  queryAllModelsTtftPercentiles,
  persistTokenUsage,
  normalizeModelKey,
  TTFT_BUCKET_BOUNDARIES_MS,
} from '../src/observability/token-usage-store.ts';
import { ensureModelTtftContainers, fmtModelTtft } from '../src/dashboard/model-status-view.js';
import { createMockD1 } from './mock-d1-database.mjs';

const HOUR = 3_600_000;
const now = () => 1_700_000_000_000;
const h0 = Math.floor((now() - 30 * 60_000) / HOUR) * HOUR; // 30 min ago, in any window
const MIN_SAMPLES = 5;

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ---- C01: container for every public model ------------------------------------
{
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'air', 400);
  const res = await queryAllModelsTtftPercentiles(env, 7, now());
  const publicModels = [
    { id: 'air' }, { id: 'code-max' }, { id: 'ultra' }, { id: 'pro' },
    { id: 'agent' }, { id: 'max' }, { id: 'flash' }, { id: 'vision' },
  ];
  const ttft = ensureModelTtftContainers(res.ttft, publicModels);
  const allPresent = publicModels.every((m) => {
    const e = ttft.get(normalizeModelKey(m.id));
    return e && e.available === true && typeof e.sampleCount === 'number';
  });
  check('C01 all 8 public models have a TTFT container (missing rows -> insufficient)',
    allPresent,
    `keys=${JSON.stringify([...ttft.keys()])}`);

  const emptyEntry = fmtModelTtft(ttft.get('vision'));
  check('C01b no-data container renders insufficient/noSamples',
    emptyEntry.insufficient === true && emptyEntry.noSamples === true
      && emptyEntry.p50 === '--s' && emptyEntry.p95 === '--s');
}

// ---- C02: fixed query count ----------------------------------------------------
{
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  for (let i = 0; i < 20; i++) {
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, `model-${i}`, 400);
  }
  const before = d1._reads.length;
  await queryAllModelsTtftPercentiles(env, 7, now());
  const reads = d1._reads.length - before;
  check('C02 one grouped TTFT query for 20 models (no N+1)', reads === 1, `reads=${reads}`);

  const d1b = createMockD1();
  const envB = { TOKEN_STATS_DB: d1b };
  for (let i = 0; i < 4; i++) {
    await persistTokenUsage(envB, { prompt_tokens: 10, completion_tokens: 5 }, h0, `model-${i}`, 400);
  }
  const beforeB = d1b._reads.length;
  await queryAllModelsTtftPercentiles(envB, 7, now());
  check('C02b query count does not scale with model count (4 models -> 1)',
    d1b._reads.length - beforeB === 1);
}

// ---- C03: canonical model key --------------------------------------------------
{
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'Code-Max', 400);
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'CODE-MAX', 600);
  const res = await queryAllModelsTtftPercentiles(env, 7, now());
  check('C03 case variants aggregate into one canonical key',
    res.ttft.size === 1 && res.ttft.has('code-max')
      && res.ttft.get('code-max').sampleCount === 2,
    `keys=${JSON.stringify([...res.ttft.keys()])}`);
}

// ---- C04: insufficient samples --------------------------------------------------
{
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  for (let i = 0; i < MIN_SAMPLES - 1; i++) {
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'rare-model', 400);
  }
  const res = await queryAllModelsTtftPercentiles(env, 7, now());
  const e = res.ttft.get('rare-model');
  check('C04 below minimum samples: p50/p95 null, insufficient true',
    e && e.p50 === null && e.p95 === null && e.insufficient === true && e.sampleCount === MIN_SAMPLES - 1,
    `entry=${JSON.stringify(e)}`);

  const d1b = createMockD1();
  const envB = { TOKEN_STATS_DB: d1b };
  for (let i = 0; i < MIN_SAMPLES; i++) {
    await persistTokenUsage(envB, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'healthy-model', 400);
  }
  const resB = await queryAllModelsTtftPercentiles(envB, 7, now());
  const eB = resB.ttft.get('healthy-model');
  check('C04b at/above minimum samples: percentiles present, insufficient false',
    eB && eB.p50 !== null && eB.p95 !== null && eB.insufficient === false,
    `entry=${JSON.stringify(eB)}`);
}

// ---- C05: bucket upper bound precision ------------------------------------------
{
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  // All samples inside bucket 1 (100..500ms): p50 and p95 must be the bucket
  // upper bound TTFT_BUCKET_BOUNDARIES_MS[1] = 500, not a precise interpolation.
  for (let i = 0; i < 10; i++) {
    await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'bucketed', 100 + i * 30);
  }
  const res = await queryAllModelsTtftPercentiles(env, 7, now());
  const e = res.ttft.get('bucketed');
  check('C05 p50/p95 are bucket upper bounds',
    e && e.p50 === TTFT_BUCKET_BOUNDARIES_MS[1] && e.p95 === TTFT_BUCKET_BOUNDARIES_MS[1],
    `p50=${e && e.p50} p95=${e && e.p95} boundaries=${JSON.stringify(TTFT_BUCKET_BOUNDARIES_MS)}`);

  // Mixed buckets: 6 samples in bucket 0 (<100ms), 4 in bucket 4 (2000..5000ms).
  // p50 (ceil(10*0.5)=5th sample) lands in bucket 0 -> upper bound 100ms;
  // p95 (ceil(10*0.95)=10th sample) lands in bucket 4 -> upper bound 5000ms.
  const d1b = createMockD1();
  const envB = { TOKEN_STATS_DB: d1b };
  for (let i = 0; i < 6; i++) {
    await persistTokenUsage(envB, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'mixed', 50);
  }
  for (let i = 0; i < 4; i++) {
    await persistTokenUsage(envB, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'mixed', 3000);
  }
  const resB = await queryAllModelsTtftPercentiles(envB, 7, now());
  const eB = resB.ttft.get('mixed');
  check('C05b percentile lands in the bucket containing the threshold sample',
    eB && eB.p50 === TTFT_BUCKET_BOUNDARIES_MS[0] && eB.p95 === TTFT_BUCKET_BOUNDARIES_MS[4],
    `p50=${eB && eB.p50} p95=${eB && eB.p95}`);
}

// ---- Fail-open -------------------------------------------------------------------
{
  const res = await queryAllModelsTtftPercentiles({}, 7, now());
  check('fail-open: missing binding -> available:false, no throw',
    res.available === false && typeof res.error === 'string');
}

if (failures > 0) {
  console.error(`ttft-query-contract: ${failures} contract(s) FAILED`);
  process.exit(1);
}
console.log('ttft-query-contract: all contracts passed');
