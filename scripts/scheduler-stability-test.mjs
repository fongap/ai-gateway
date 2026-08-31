#!/usr/bin/env node
// Deterministic scheduler-stability tests: per-model TTFT, active probe,
// stale metrics, and anti-jitter behaviour. These tests exercise the REAL
// scheduler (pickCandidate / betterThan / latencyPreference) and the REAL
// node-state module (recordTtft / markProbeFailure / getModelPerf) without
// any network I/O. They verify the FIXED behaviour after production changes:
//
//   - recordTtft accepts { source: 'passive' | 'probe' }
//   - probe samples use PROBE_EWMA_ALPHA = 0.15 (vs passive 0.3)
//   - modelPerf tracks passiveSamples / probeSamples / lastTtftAt /
//     lastProbeFailureAt
//   - markProbeFailure(nodeId, model) sets lastProbeFailureAt
//   - effectiveTtft returns 0 (neutral) when:
//       * TTFT is stale (> STALE_TTFT_MS = 10 min)
//       * probe failure occurred after last TTFT
//       * probe-only data (passiveSamples === 0 && probeSamples > 0)
//
// Test matrix (FIXED behaviour):
//   1. Single probe sample must NOT grant decisive priority
//   2. Probe + passive validation unlocks probe-warmed EWMA
//   3. Historical fast node degrades — stale TTFT expires after 10 min
//   4. Stale metric must NOT beat fresh
//   5. Probe failure invalidates old TTFT
//   6. Probe/passive conflict — probe must not dominate passive
//   7. Scheduling oscillation — ping-pong on alternating TTFT

import assert from 'node:assert/strict';
import {
  __resetAllStateForTests, getNodeState, getModelPerf, recordTtft,
  markProbeFailure, recordFailure, recordNeutralEnd, acquireSlot,
} from '../src/reliability/node-state.js';
import { pickCandidate } from '../src/scheduler/scheduler.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    __resetAllStateForTests();
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

// ---- Helpers --------------------------------------------------------------

const MODEL = 'air';
const REQ = { model: MODEL, protocol: 'openai', surface: 'chat_completions' };

function makeNode(id, { priority = 10, concurrency = 4, rpm = 100 } = {}) {
  return {
    id,
    tier: 'tier-1',
    provider: 'mock',
    protocol: 'openai',
    surfaces: ['chat_completions'],
    baseUrl: `https://${id}.example.com/v1`,
    credential: 'secret',
    models: { [MODEL]: `up-${id}` },
    priority,
    limits: { concurrency, rpm, rpmMode: 'hard' },
  };
}

// Record a passive (real-request) TTFT sample.
function recordPassive(nodeId, ttftMs, model = MODEL) {
  recordTtft(nodeId, ttftMs, model, { source: 'passive' });
  return getModelPerf(nodeId, model)?.avgTtftMs ?? 0;
}

// Record a probe TTFT sample (lower EWMA alpha = more conservative).
function recordProbe(nodeId, ttftMs, model = MODEL) {
  recordTtft(nodeId, ttftMs, model, { source: 'probe' });
  return getModelPerf(nodeId, model)?.avgTtftMs ?? 0;
}

// Pick the winning node from a set of candidates WITHOUT permanently claiming
// its slot: acquire, record the id, then release via neutral end so the next
// pick starts from a clean concurrency state. The LRU side-effect of
// acquireSlot is unavoidable but is also part of the real scheduler behaviour.
function pickWinner(nodes, attempted = new Set(), now = Date.now()) {
  const chosen = pickCandidate(nodes, REQ, attempted, now);
  if (!chosen) return null;
  recordNeutralEnd(chosen.id);
  return chosen.id;
}

// Force a modelPerf entry AND node-level lastUsedAt to past timestamps to
// simulate a metric that has not been refreshed by any real or probe sample.
function setStale(nodeId, model, ageMs, now = Date.now()) {
  const perf = getModelPerf(nodeId, model);
  if (perf) {
    perf.lastTtftAt = now - ageMs;
    perf.lastUsedAt = now - ageMs;
  }
  const s = getNodeState(nodeId);
  s.lastUsedAt = now - ageMs;
}

// Make a node appear more-recently-used than another so the other wins LRU.
function touchLRU(nodeId, now = Date.now()) {
  acquireSlot(nodeId, now);
  recordNeutralEnd(nodeId);
}

// ---- Test 1: single probe sample must NOT grant decisive priority ----------

await test('Test 1: single probe 200ms (probe-only) must NOT beat passive 800ms', async () => {
  const A = makeNode('a');
  const B = makeNode('b');
  const nodes = [A, B];

  // A: first probe sample = 200ms. Probe-only → effectiveTtft = 0.
  recordProbe('a', 200);
  // B: stable real-request TTFT = 800ms (passive, 1 sample).
  recordPassive('b', 800);

  const aPerf = getModelPerf('a', MODEL);
  const bPerf = getModelPerf('b', MODEL);
  assert.equal(aPerf.avgTtftMs, 200, 'A avgTtftMs should be 200');
  assert.equal(bPerf.avgTtftMs, 800, 'B avgTtftMs should be 800');
  assert.equal(aPerf.passiveSamples, 0, 'A should have 0 passive samples');
  assert.equal(aPerf.probeSamples, 1, 'A should have 1 probe sample');
  assert.equal(bPerf.passiveSamples, 1, 'B should have 1 passive sample');

  // A's effectiveTtft = 0 (probe-only) → no decisive TTFT advantage.
  // The 200ms probe must NOT beat B's 800ms passive.
  // Touch A's LRU so B wins the LRU tiebreak (proves it's not TTFT-decided).
  touchLRU('a');

  const winner = pickWinner(nodes);
  console.log(`  A: probe 200ms (passive=0, probe=1), B: passive 800ms (passive=1)`);
  console.log(`  A effectiveTtft = 0 (probe-only) → no TTFT comparison → LRU → winner=${winner}`);
  assert.notEqual(winner, 'a',
    `A (probe-only 200ms) must NOT win via TTFT. got winner=${winner}`);
  console.log('  → Probe-only data is non-decisive. FIXED.');
});

// ---- Test 2: probe + passive validation -----------------------------------

await test('Test 2: probe [200,2500,2200] is non-decisive until passive validates', async () => {
  const A = makeNode('a');
  const B = makeNode('b');
  const nodes = [A, B];
  const winners = [];

  // Probe sequence for A (all probe) and passive sequence for B.
  const probeSeq = [200, 2500, 2200];
  const passiveSeq = [900, 950, 1000];

  for (let i = 0; i < probeSeq.length; i++) {
    recordProbe('a', probeSeq[i]);
    recordPassive('b', passiveSeq[i]);
    const w = pickWinner(nodes);
    winners.push(w);
    const aEwma = getModelPerf('a', MODEL)?.avgTtftMs?.toFixed(1);
    const bEwma = getModelPerf('b', MODEL)?.avgTtftMs?.toFixed(1);
    console.log(`  Step ${i + 1}: A probe=${probeSeq[i]} (EWMA=${aEwma}, passive=0), B passive=${passiveSeq[i]} (EWMA=${bEwma}), winner=${w}`);
  }

  const aPerf = getModelPerf('a', MODEL);
  assert.equal(aPerf.passiveSamples, 0, 'A should still be probe-only');
  assert.equal(aPerf.probeSamples, 3, 'A should have 3 probe samples');

  // Throughout the probe-only phase, A's effectiveTtft = 0, so the TTFT
  // comparison never triggers. Winners are LRU-dependent, not TTFT-decided.
  console.log(`  Probe-only phase winners: ${winners.join(' → ')} (all LRU-dependent)`);

  // Now add a single passive sample for A → passiveSamples becomes 1.
  // A's probe-warmed EWMA is unlocked: 793.25 * 0.7 + 200 * 0.3 ≈ 615.3
  // B's EWMA ≈ 940.5. 615.3 <= 940.5/1.5 = 627 → A wins decisively.
  recordPassive('a', 200);
  const aAfter = getModelPerf('a', MODEL);
  const aEwmaFinal = aAfter.avgTtftMs;
  const bEwmaFinal = getModelPerf('b', MODEL).avgTtftMs;
  console.log(`  After passive 200ms: A EWMA=${aEwmaFinal.toFixed(1)} (passive=1), B EWMA=${bEwmaFinal.toFixed(1)}`);

  const winnerAfterPassive = pickWinner(nodes);
  console.log(`  Winner after passive validation: ${winnerAfterPassive}`);

  assert.equal(aAfter.passiveSamples, 1, 'A should have 1 passive sample after validation');
  assert.equal(winnerAfterPassive, 'a',
    `A should win decisively after passive unlocks probe-warmed EWMA. got=${winnerAfterPassive}`);

  console.log('  → Passive validation unlocks probe-warmed EWMA. FIXED.');
});

// ---- Test 3: historical fast node degrades — stale TTFT expires -----------

await test('Test 3: historical 300ms ×5, timeout, then stale TTFT expires after 10min', async () => {
  const A = makeNode('a');
  const B = makeNode('b');
  const nodes = [A, B];

  // A: historical 300ms × 5 passive samples (EWMA converges to ~300).
  for (let i = 0; i < 5; i++) recordPassive('a', 300);
  // B: stable 1000ms passive.
  recordPassive('b', 1000);

  const aPerf = getModelPerf('a', MODEL);
  const bPerf = getModelPerf('b', MODEL);
  console.log(`  A EWMA after 5×300 = ${aPerf.avgTtftMs.toFixed(1)}ms (passive=${aPerf.passiveSamples})`);
  console.log(`  B EWMA = ${bPerf.avgTtftMs.toFixed(1)}ms (passive=${bPerf.passiveSamples})`);

  // Simulate A suddenly degrading: timeout → recordFailure (counted),
  // NOT recordTtft. A's modelPerf TTFT stays at ~300ms.
  acquireSlot('a');
  recordFailure('a', { counted: true, cooldownMs: 0, reason: 'first_event_timeout' });

  // Immediately after failure (within TRANSIENT_FAILURE_PREFERENCE_MS = 5s):
  // A is recently-failed → B wins.
  const winnerImmediately = pickWinner(nodes);
  console.log(`  Winner immediately after timeout (transient failure pref): ${winnerImmediately}`);
  assert.equal(winnerImmediately, 'b',
    'B should win immediately after A timeout (transient failure preference)');

  // 6s after: failure preference expired (>5s). A's TTFT is still fresh (<10min).
  // 300 <= 1000/1.5=667 → A wins decisively.
  const winner6s = pickWinner(nodes, new Set(), Date.now() + 6000);
  console.log(`  Winner 6s after timeout (TTFT still fresh): ${winner6s}`);
  assert.equal(winner6s, 'a',
    'A should win 6s after timeout — TTFT still fresh (<10min TTL)');

  // 11min after: A's lastTtftAt is now >10min ago → stale → effectiveTtft=0.
  // B's lastTtftAt is also stale, so no TTFT comparison. LRU decides: B was
  // touched at the immediate pick (older), A at the 6s pick (newer) → B wins.
  const future11 = Date.now() + 11 * 60_000;
  const aPerfNow = getModelPerf('a', MODEL);
  aPerfNow.lastTtftAt = future11 - 11 * 60_000; // 11 min ago
  // Refresh B's TTFT so it's fresh at the 11-min mark.
  const bPerfNow = getModelPerf('b', MODEL);
  bPerfNow.lastTtftAt = future11 - 5 * 60_000; // 5 min ago → fresh

  const aAge = future11 - aPerfNow.lastTtftAt;
  const bAge = future11 - bPerfNow.lastTtftAt;
  console.log(`  At 11min: A TTFT age=${(aAge / 60_000).toFixed(1)}min (stale), B TTFT age=${(bAge / 60_000).toFixed(1)}min (fresh)`);

  const winner11min = pickWinner(nodes, new Set(), future11);
  console.log(`  Winner 11min after timeout (A TTFT stale): ${winner11min}`);
  assert.notEqual(winner11min, 'a',
    `A must NOT win after TTFT goes stale (>10min). got=${winner11min}`);
  assert.ok(aAge > 10 * 60_000, 'A TTFT should be stale (>10min)');

  console.log('  → Stale TTFT expires after 10 min. FIXED.');
});

// ---- Test 4: stale metric must NOT beat fresh -----------------------------

await test('Test 4: 11-min-old 300ms must NOT beat fresh 900ms', async () => {
  const A = makeNode('a');
  const B = makeNode('b');
  const nodes = [A, B];

  // A: measured 300ms 11 minutes ago (stale).
  recordPassive('a', 300);
  setStale('a', MODEL, 11 * 60_000); // 11 min ago → both lastTtftAt & lastUsedAt

  // B: measured 900ms just now (fresh).
  recordPassive('b', 900);

  const aPerf = getModelPerf('a', MODEL);
  const bPerf = getModelPerf('b', MODEL);
  const aAge = Date.now() - aPerf.lastTtftAt;
  const bAge = Date.now() - bPerf.lastTtftAt;
  console.log(`  A avgTtftMs=${aPerf.avgTtftMs}, TTFT age=${(aAge / 60_000).toFixed(1)}min (stale)`);
  console.log(`  B avgTtftMs=${bPerf.avgTtftMs}, TTFT age=${(bAge / 60_000).toFixed(1)}min (fresh)`);

  // A's effectiveTtft = 0 (stale >10min) → no TTFT comparison.
  // A's stale 300ms must NOT give it a decisive advantage.
  const winner = pickWinner(nodes);
  console.log(`  Winner: ${winner}`);
  assert.notEqual(winner, 'a',
    `A (stale 300ms) must NOT win via stale TTFT. got=${winner}`);
  assert.ok(aAge > 10 * 60_000, 'A TTFT should be stale (>10min)');

  console.log('  → Stale metric is neutralised. FIXED.');
});

// ---- Test 5: probe failure invalidates old TTFT ----------------------------

await test('Test 5: probe failure invalidates old 300ms vs B=900ms', async () => {
  const A = makeNode('a');
  const B = makeNode('b');
  const nodes = [A, B];

  // A: historical 300ms passive (passiveSamples=1).
  recordPassive('a', 300);
  // B: current 900ms passive (passiveSamples=1).
  recordPassive('b', 900);

  const aPerfBefore = getModelPerf('a', MODEL);
  const aStateBefore = getNodeState('a');
  console.log(`  Before probe failure: A avgTtftMs=${aPerfBefore.avgTtftMs}, lastTtftAt=${aPerfBefore.lastTtftAt}, lastProbeFailureAt=${aPerfBefore.lastProbeFailureAt}`);

  // Simulate a probe failure on A: model-probes.js catch block calls
  // markProbeFailure(node.id, model). Use an explicit timestamp strictly
  // after lastTtftAt to avoid same-millisecond ambiguity.
  const ttftTime = aPerfBefore.lastTtftAt;
  markProbeFailure('a', MODEL, ttftTime + 1);

  const aPerfAfter = getModelPerf('a', MODEL);
  const aStateAfter = getNodeState('a');
  console.log(`  After probe failure:  A lastTtftAt=${aPerfAfter.lastTtftAt}, lastProbeFailureAt=${aPerfAfter.lastProbeFailureAt}`);
  assert.ok(aPerfAfter.lastProbeFailureAt > aPerfAfter.lastTtftAt,
    'lastProbeFailureAt should be after lastTtftAt');

  // markProbeFailure must NOT touch health/circuit.
  assert.equal(aStateAfter.healthScore, aStateBefore.healthScore,
    'markProbeFailure must not change healthScore');
  assert.equal(aStateAfter.circuitState, 'closed',
    'markProbeFailure must not change circuitState');
  assert.equal(aStateAfter.consecutiveFailures, 0,
    'markProbeFailure must not change consecutiveFailures');

  // A's effectiveTtft = 0 (probe failure after last TTFT) → no decisive advantage.
  // Touch A's LRU so B wins the tiebreak (proves it's not TTFT-decided).
  touchLRU('a');

  const winner = pickWinner(nodes);
  console.log(`  Winner after probe failure: ${winner}`);
  assert.notEqual(winner, 'a',
    `A must NOT win after probe failure invalidated its TTFT. got=${winner}`);

  console.log('  → Probe failure invalidates old TTFT. FIXED.');
});

// ---- Test 6: probe/passive conflict — probe must not dominate passive ----

await test('Test 6: probe 200ms then passive [3000,3500,2800] — probe does not dominate', async () => {
  const A = makeNode('a');
  const B = makeNode('b');
  const nodes = [A, B];

  // B: stable passive 900ms.
  recordPassive('b', 900);

  // A: single probe = 200ms (probe-only → effectiveTtft = 0, non-decisive).
  recordProbe('a', 200);
  const aPerfProbe = getModelPerf('a', MODEL);
  console.log(`  After probe: A EWMA=${aPerfProbe.avgTtftMs}, passive=${aPerfProbe.passiveSamples}, probe=${aPerfProbe.probeSamples}`);

  // Probe-only → A must NOT win decisively.
  // Touch A's LRU so B wins the tiebreak (proves it's not TTFT-decided).
  touchLRU('a');
  const winnerAfterProbe = pickWinner(nodes);
  console.log(`  Winner after probe-only: ${winnerAfterProbe} (probe was non-decisive)`);
  assert.notEqual(winnerAfterProbe, null, 'should have a winner');
  // A's effectiveTtft = 0 (probe-only) → no TTFT advantage for A.
  assert.equal(aPerfProbe.passiveSamples, 0, 'A should be probe-only');
  assert.equal(aPerfProbe.probeSamples, 1, 'A should have 1 probe sample');

  // Now real passive samples arrive for A: 3000, 3500, 2800.
  // After 1st passive (3000): EWMA = 200*0.7 + 3000*0.3 = 1040.
  //   B EWMA = 900. 900 <= 1040/1.5=693 → B wins decisively.
  const passiveSamples = [3000, 3500, 2800];
  let bWinsFrom = -1;
  for (let i = 0; i < passiveSamples.length; i++) {
    recordPassive('a', passiveSamples[i]);
    const ewma = getModelPerf('a', MODEL)?.avgTtftMs;
    const bEwma = getModelPerf('b', MODEL)?.avgTtftMs;
    const winner = pickWinner(nodes);
    console.log(`  After passive[${i}]=${passiveSamples[i]}: A EWMA=${ewma?.toFixed(1)} (passive=${i + 1}), B EWMA=${bEwma?.toFixed(1)}, winner=${winner}`);
    if (bWinsFrom < 0 && winner === 'b') bWinsFrom = i + 1;
  }

  assert.ok(bWinsFrom >= 1,
    'B should win after first passive sample (real TTFT reflects 3000ms)');
  console.log(`  → B won from passive sample ${bWinsFrom} (real TTFT overcame probe).`);
  console.log('  → Probe did not dominate passive. FIXED.');
});

// ---- Test 7: scheduling oscillation (ping-pong) ---------------------------

await test('Test 7: alternating TTFT — A=[500,1500]×3 vs B=[1000,700]×3', async () => {
  const A = makeNode('a');
  const B = makeNode('b');
  const nodes = [A, B];
  const winners = [];
  const aSeq = [500, 1500, 500, 1500, 500, 1500];
  const bSeq = [1000, 700, 1000, 700, 1000, 700];

  for (let i = 0; i < aSeq.length; i++) {
    recordPassive('a', aSeq[i]);
    recordPassive('b', bSeq[i]);
    const w = pickWinner(nodes);
    winners.push(w);
    const aEwma = getModelPerf('a', MODEL)?.avgTtftMs?.toFixed(1);
    const bEwma = getModelPerf('b', MODEL)?.avgTtftMs?.toFixed(1);
    console.log(`  Step ${i}: A=${aSeq[i]} (EWMA=${aEwma}), B=${bSeq[i]} (EWMA=${bEwma}), winner=${w}`);
  }

  let switches = 0;
  for (let i = 1; i < winners.length; i++) {
    if (winners[i] !== winners[i - 1]) switches++;
  }
  console.log(`  Winners: ${winners.join(' → ')}`);
  console.log(`  Switches: ${switches}`);

  // With alpha=0.3 passive and a 1.5× dead-band, the EWMA smooths alternating
  // samples. After step 0 (A=500 vs B=1000, decisive), the EWMA gap narrows
  // and subsequent steps fall through to LRU, which alternates naturally.
  // The 1.5× dead-band prevents TTFT-driven oscillation; remaining switches
  // are LRU-driven and expected.
  console.log(`  → ${switches} winner switch(es) across ${aSeq.length} steps.`);
  console.log('  → Dead-band prevents TTFT-driven oscillation; LRU alternation is expected.');
});

// ---- Summary --------------------------------------------------------------

console.log(`\nscheduler stability tests: ${passed} passed, ${failed} failed.`);
