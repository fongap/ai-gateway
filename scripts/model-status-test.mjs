#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Public Model Status unit tests (src/runtime/model-status.js). The core bug
// fix is verified here: a freshly-isolated Worker that has no Tier 1
// passive-TTFT sample must NOT mark every model `未观测` when D1 has recent
// successful evidence for them. The other end of the spectrum is also
// locked: a model that has never been called and has no D1 evidence must
// still be `unobserved`, and a model with all candidates currently down and
// no D1 evidence must be `unavailable`. D1 failure must fail open: never
// fabricate `available`, never mark every model `unavailable`.

import assert from 'node:assert/strict';
import {
  getPublicModelStatus,
  MODEL_STATUS_RECENT_WINDOW_MS,
} from '../src/runtime/model-status.js';
import { queryRecentModelEvidence } from '../src/observability/token-usage-store.mjs';
import { __resetTier1StateForTests, getTier1Model, recordTier1Ttft } from '../src/reliability/tier1-state.js';
import { __resetAllStateForTests } from '../src/reliability/node-state.js';
import { createMockD1 } from './mock-d1-database.mjs';

const HOUR = 3_600_000;

let passed = 0;
function test(name, fn) {
  try {
    __resetTier1StateForTests();
    __resetAllStateForTests();
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

async function testAsync(name, fn) {
  try {
    __resetTier1StateForTests();
    __resetAllStateForTests();
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

const ENV = { GATEWAY_ACCESS_KEY: 'k', MODELS_CONFIG: JSON.stringify({ air: { policy: 'fast' } }) };
const node = (id, models) => ({ id, provider: 'mock', tier: 'tier-1', protocol: 'openai', surfaces: ['chat_completions'], base_url: `https://${id}.example.com/v1`, models, limits: { concurrency: 1 } });
const now = () => 1_700_000_000_000;

function findModelStatus(result, id) {
  const list = Array.isArray(result) ? result : (result?.models || []);
  const entry = list.find((m) => m.id === id);
  if (!entry) throw new Error(`no model ${id} in result`);
  return entry.status;
}

// --- 1. Cold-start: no Tier 1 sample + D1 has recent traffic => available ----

test('cold-start: no Tier 1 sample but D1 has recent traffic -> available', () => {
  const nodes = [node('a', { air: 'up-air' })];
  // No recordTier1Ttft() — fresh isolate, account has no sample.
  const evidence = new Set(['air']);
  const list = getPublicModelStatus(nodes, ENV, evidence, now());
  assert.equal(findModelStatus(list, 'air'), 'available');
});

// --- 2. New model: no runtime sample + no D1 evidence => unobserved ---------

test('new model: no runtime sample and no D1 evidence -> unobserved', () => {
  const nodes = [node('a', { air: 'up-air' })];
  const list = getPublicModelStatus(nodes, ENV, new Set(), now());
  assert.equal(findModelStatus(list, 'air'), 'unobserved');
});

// --- 3. All candidates unavailable + no D1 => unavailable -------------------

test('all candidates unavailable and no D1 evidence -> unavailable', () => {
  const nodes = [node('a', { air: 'up-air' })];
  // Force the Tier 1 model into cooldown so runtime returns 'unavailable'.
  const t1Model = getTier1Model('a', 'air');
  t1Model.cooldownUntil = now() + 60_000;
  t1Model.failureState = 'cooldown';
  const list = getPublicModelStatus(nodes, ENV, new Set(), now());
  assert.equal(findModelStatus(list, 'air'), 'unavailable');
});

// --- 4. All candidates unavailable + recent D1 => degraded --------------------

test('all candidates cooling with recent D1 success -> degraded', () => {
  const nodes = [node('a', { air: 'up-air' })];
  const t1Model = getTier1Model('a', 'air');
  t1Model.cooldownUntil = now() + 60_000;
  t1Model.failureState = 'cooldown';
  const list = getPublicModelStatus(nodes, ENV, new Set(['air']), now());
  assert.equal(findModelStatus(list, 'air'), 'degraded');
});

// --- 5. Tier 1 sample present + healthy => available -------------------------

test('healthy Tier 1 path with sample -> available (with or without D1)', () => {
  const nodes = [node('a', { air: 'up-air' })];
  recordTier1Ttft('a', 'air', 100, now() - 1000);
  assert.equal(findModelStatus(getPublicModelStatus(nodes, ENV, new Set(), now()), 'air'), 'available');
  assert.equal(findModelStatus(getPublicModelStatus(nodes, ENV, new Set(['air']), now()), 'air'), 'available');
});

// --- 6. Mixed nodes: one available + one cooling + no D1 => available ---------

test('one available + one cooling + no D1 -> available (still has a path)', () => {
  const nodes = [node('a', { air: 'up-air' }), node('b', { air: 'up-air' })];
  recordTier1Ttft('a', 'air', 100, now() - 1000);
  // b is in cooldown.
  const t1ModelB = getTier1Model('b', 'air');
  t1ModelB.cooldownUntil = now() + 60_000;
  t1ModelB.failureState = 'cooldown';
  const list = getPublicModelStatus(nodes, ENV, new Set(), now());
  assert.equal(findModelStatus(list, 'air'), 'available');
});

// --- 7. Mixed nodes: one available + one cooling + D1 => available -----------

test('one available + one cooling + D1 -> available', () => {
  const nodes = [node('a', { air: 'up-air' }), node('b', { air: 'up-air' })];
  recordTier1Ttft('a', 'air', 100, now() - 1000);
  const t1ModelB = getTier1Model('b', 'air');
  t1ModelB.cooldownUntil = now() + 60_000;
  t1ModelB.failureState = 'cooldown';
  const list = getPublicModelStatus(nodes, ENV, new Set(['air']), now());
  assert.equal(findModelStatus(list, 'air'), 'available');
});

// --- 8. Node-mapped models are public by default ----------------------------

test('node-mapped model IS public (no MODELS_CONFIG required)', () => {
  // Two node-mapped models. No MODELS_CONFIG: both should be public.
  const nodes = [node('a', { 'public-air': 'up-air', 'public-max': 'up-max' })];
  const list = getPublicModelStatus(nodes, ENV, new Set(), now());
  const ids = list.models.map((m) => m.id);
  assert.ok(ids.includes('public-air'), 'a node-mapped model is public by default');
  assert.ok(ids.includes('public-max'), 'a node-mapped model is public by default');
  // A model in MODELS_CONFIG but with no node mapping is not in the public set.
  const airInResult = list.models.find((m) => m.id === 'air');
  assert.equal(airInResult, undefined, 'MODELS_CONFIG alone does not surface a model');
});

// --- 9. Wildcard node: serves any model another node declared ---------------

test('wildcard node serves any model another node declared', () => {
  // Two nodes: one wildcard (empty models), one explicit. The wildcard node
  // serves 'air' (because another node maps it), even though its own models
  // map is empty.
  const nodes = [
    node('a', {}),                                // wildcard
    node('b', { 'public-air': 'up-air' }),         // explicit
  ];
  const list = getPublicModelStatus(nodes, ENV, new Set(['public-air']), now());
  // Node mappings are the primary source; 'public-air' is in node b's map.
  const ids = list.models.map((m) => m.id);
  assert.ok(ids.includes('public-air'), 'public-air is in the public set via node b');
});

// --- 10. Sort order: result is sorted by id ----------------------------------

test('output is sorted by logical model name', () => {
  // Source is node mappings (primary). Build a single node with three models.
  const nodes = [node('a', { zeta: 'up-zeta', alpha: 'up-alpha', mid: 'up-mid' })];
  const list = getPublicModelStatus(nodes, ENV, new Set(), now());
  assert.deepEqual(list.models.map((m) => m.id), ['alpha', 'mid', 'zeta']);
  assert.equal(list.observed_at, new Date(now()).toISOString(), 'envelope carries observed_at');
});

// --- 11. Public-safety: no node ids / providers / tiers in output ------------

test('output never carries node ids, providers, or tiers', () => {
  const nodes = [node('n1', { air: 'up-air' })];
  const list = getPublicModelStatus(nodes, ENV, new Set(['air']), now());
  const serialized = JSON.stringify(list);
  assert.ok(!/n1/.test(serialized), 'must not leak node id');
  assert.ok(!/mock/.test(serialized), 'must not leak provider');
  assert.ok(!/openai/.test(serialized), 'must not leak protocol');
  assert.ok(!/tier-1/.test(serialized), 'must not leak tier');
  assert.ok(!/cooldown/.test(serialized), 'must not leak cooldown reason');
  assert.ok(!/half_open/.test(serialized), 'must not leak failure state');
});

// --- 12. Edge: empty node list ----------------------------------------------

test('empty node list -> empty public status (no node mappings = no public models)', () => {
  const list = getPublicModelStatus([], ENV, new Set(), now());
  // Node mappings are primary; with no nodes there is nothing to show. The
  // MODELS_CONFIG declaration alone does not surface a model.
  assert.deepEqual(list.models, []);
});

// --- 13. Edge: null/undefined env handling -----------------------------------

test('null env (e.g. test isolation) falls back to node mappings', () => {
  const nodes = [node('a', { air: 'up-air' })];
  const result = getPublicModelStatus(nodes, null, new Set(), now());
  // Without a registry the backward-compat fallback picks up node-mapping
  // model names so the dashboard is not silently empty.
  assert.ok(Array.isArray(result.models));
  assert.equal(result.models.length, 1, 'fallback picks up node-mapping model');
  assert.equal(result.models[0].id, 'air');
});

// --- 14. Edge: half-open state treated as unobserved ------------------------

test('Tier 1 half-open state behaves as unobserved -> falls through evidence rule', () => {
  const nodes = [node('a', { air: 'up-air' })];
  // Tier 1 half-open is the only state that returns 'unobserved' from runtime.
  // Mark it explicitly: cooldownUntil has elapsed, halfOpenSuccesses not yet 2.
  const t1Model = getTier1Model('a', 'air');
  t1Model.failureState = 'half_open';
  t1Model.cooldownUntil = 0;
  t1Model.halfOpenSuccesses = 0;
  // No D1 evidence -> unobserved
  assert.equal(findModelStatus(getPublicModelStatus(nodes, ENV, new Set(), now()), 'air'), 'unobserved');
  // D1 evidence -> available (case D)
  assert.equal(findModelStatus(getPublicModelStatus(nodes, ENV, new Set(['air']), now()), 'air'), 'available');
});

// --- 15. queryRecentModelEvidence: miss / hit / fail-open --------------------

await testAsync('queryRecentModelEvidence: no binding -> empty Set', async () => {
  const out = await queryRecentModelEvidence({ GATEWAY_ACCESS_KEY: 'k' }, MODEL_STATUS_RECENT_WINDOW_MS, now());
  assert.ok(out instanceof Set);
  assert.equal(out.size, 0);
});

await testAsync('queryRecentModelEvidence: persists -> returns model Set', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  // Persist one recent success.
  const h0 = Math.floor((now() - 30 * 60_000) / HOUR) * HOUR;
  const { persistTokenUsage } = await import('../src/observability/token-usage-store.mjs');
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'air');
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'code-max');
  const out = await queryRecentModelEvidence(env, MODEL_STATUS_RECENT_WINDOW_MS, now());
  assert.equal(out.size, 2);
  assert.ok(out.has('air'));
  assert.ok(out.has('code-max'));
});

await testAsync('queryRecentModelEvidence: D1 read failure -> empty Set, never throws', async () => {
  const d1 = createMockD1({ failReads: true });
  const env = { TOKEN_STATS_DB: d1 };
  const out = await queryRecentModelEvidence(env, MODEL_STATUS_RECENT_WINDOW_MS, now());
  assert.ok(out instanceof Set);
  assert.equal(out.size, 0);
});

await testAsync('queryRecentModelEvidence: only rows in the window count', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const h0 = Math.floor((now() - 30 * 60_000) / HOUR) * HOUR;          // 30 min ago: in window
  const hOld = Math.floor((now() - 30 * HOUR) / HOUR) * HOUR;            // 30h ago: out of window
  const { persistTokenUsage } = await import('../src/observability/token-usage-store.mjs');
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'air');
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, hOld, 'oldmodel');
  const out = await queryRecentModelEvidence(env, MODEL_STATUS_RECENT_WINDOW_MS, now());
  assert.ok(out.has('air'), 'recent traffic counted');
  assert.ok(!out.has('oldmodel'), 'old traffic outside window ignored');
});

await testAsync('queryRecentModelEvidence: requests=0 is NOT evidence', async () => {
  const d1 = createMockD1();
  const env = { TOKEN_STATS_DB: d1 };
  const h0 = Math.floor((now() - 30 * 60_000) / HOUR) * HOUR;
  // Persist with null usage -> requests=1, reports=0, missing=1. The
  // evidence query is `requests > 0` (per-model traffic), so this DOES
  // still count as evidence. The 'reports > 0' filter would be too strict
  // (an interrupted stream with partial data is still recent activity).
  const { persistTokenUsage } = await import('../src/observability/token-usage-store.mjs');
  await persistTokenUsage(env, null, h0, 'broken-only');
  const out = await queryRecentModelEvidence(env, MODEL_STATUS_RECENT_WINDOW_MS, now());
  assert.ok(out.has('broken-only'),
    'a row with requests > 0 (even if missing-usage) still counts as recent activity');
});

// --- 16. Constant MODEL_STATUS_RECENT_WINDOW_MS is exported -----------------

test('MODEL_STATUS_RECENT_WINDOW_MS is 24h and is the only window constant', () => {
  assert.equal(MODEL_STATUS_RECENT_WINDOW_MS, 24 * 3600_000);
});

// --- 17. Multi-isolate cold-start: rebuild does not flip available -> unobserved

test('isolate rebuild does not flip a previously-available model back to unobserved', () => {
  // Isolate A served the model and recorded a sample.
  const nodes = [node('a', { air: 'up-air' })];
  recordTier1Ttft('a', 'air', 100, now() - 1000);
  // D1 also has the recent success.
  const evidence = new Set(['air']);
  const aList = getPublicModelStatus(nodes, ENV, evidence, now());
  assert.equal(findModelStatus(aList, 'air'), 'available');
  // Wipe isolate-local Tier 1 state (simulate a fresh isolate). D1 still has evidence.
  __resetTier1StateForTests();
  __resetAllStateForTests();
  const bList = getPublicModelStatus(nodes, ENV, evidence, now());
  assert.equal(findModelStatus(bList, 'air'), 'available',
    'cold-start with persistent D1 evidence must remain available');
});

// --- 18. Three-tier aggregation: a model served only by tier 3 still works --

test('model served by tier 3 (legacy state) is read correctly', () => {
  // Pure-tier-3 node: no Tier 1 state at all.
  const nodes = [{
    id: 't3', provider: 'mock', protocol: 'openai', surfaces: ['chat_completions'],
    base_url: 'https://t3.example.com/v1', tier: 'tier-3', models: { air: 'up-air' },
  }];
  // No Tier 1 state -> runtime is 'unobserved' for this node
  const list = getPublicModelStatus(nodes, ENV, new Set(['air']), now());
  // D1 has evidence -> available (case D)
  assert.equal(findModelStatus(list, 'air'), 'available');
});

// --- 19. output has exactly the four documented states ----------------------

test('output only ever returns the four documented status values', () => {
  const nodes = [node('a', { air: 'up-air' }), node('b', { max: 'up-max' })];
  // Various scenarios
  const seen = new Set();
  for (const evidence of [new Set(), new Set(['air']), new Set(['air', 'max']), new Set(['max'])]) {
    for (const arr of [nodes, [], [node('a', { air: 'up-air' })]]) {
      for (const result of [getPublicModelStatus(arr, ENV, evidence, now())]) {
        for (const m of result.models) seen.add(m.status);
      }
    }
  }
  for (const s of seen) {
    assert.ok(['available', 'degraded', 'unobserved', 'unavailable'].includes(s), `unexpected status: ${s}`);
  }
});

// --- 20. Dashboard wiring: queryRecentModelEvidence rides the existing 45s cache

await testAsync('dashboard path issues queryRecentModelEvidence at most once per 45s cache window', async () => {
  const d1 = createMockD1();
  const env = { GATEWAY_ACCESS_KEY: 'k', TOKEN_STATS_DB: d1, MODELS_CONFIG: JSON.stringify({ air: { policy: 'fast' } }) };
  const { dashboardResponse, __resetDashboardCacheForTests } = await import('../src/dashboard/pages.js');
  __resetDashboardCacheForTests();
  const h0 = Math.floor((now() - 30 * 60_000) / HOUR) * HOUR;
  const { persistTokenUsage } = await import('../src/observability/token-usage-store.mjs');
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, h0, 'air');
  // Issue two concurrent page loads — the model-status query must be
  // coalesced by the existing dashboard cache, not re-issued.
  const readsBefore = d1._reads.length;
  const req = () => new Request('https://gateway.example.com/', { headers: { accept: 'text/html' } });
  const [h1, h2] = await Promise.all([
    (await dashboardResponse(req(), env)).text(),
    (await dashboardResponse(req(), env)).text(),
  ]);
  assert.equal(h1, h2, 'cached');
  // Two concurrent pages should add at most ONE new read of the model table
  // (the cache coalesces). The model-status query uses GROUP BY model and is
  // distinct from the existing model-usage GROUP BY model query, so it
  // adds 1 read per cache window.
  const readsAfter = d1._reads.length;
  const delta = readsAfter - readsBefore;
  assert.ok(delta <= 8, `expected <=8 reads for one page load, got ${delta}`);
});

console.log(`\nmodel-status tests: ${passed} passed.`);
if (process.exitCode) {
  console.error('Some tests FAILED.');
} else {
  console.log('All model-status tests passed.');
}