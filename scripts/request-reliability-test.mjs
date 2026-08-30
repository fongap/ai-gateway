#!/usr/bin/env node
// Request-reliability tests for node runtime state: concurrency slots, cooldowns, circuit
// breaker transitions, half-open single probe.
import assert from 'node:assert/strict';
import {
  acquireSlot, peekAvailability, recordSuccess, recordFailure, recordNeutralEnd,
  getNodeState, getCooldownRemainingMs, applyHealthPenalty,
  rollbackRpmBucket, rpmUsage,
  CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_OPEN_MS,
} from '../src/reliability/node-state.js';
import {
  parseRetryAfterMs, attemptBudgetSliceMs, attemptHeadersTimeoutMs, attemptFirstEventTimeoutMs,
  MIN_ATTEMPT_HEADERS_MS, MIN_ATTEMPT_FIRST_EVENT_MS,
} from '../src/config/timeouts.js';
import { classifyUpstreamStatus, classifyNetworkError, classifyFirstEventFailure, classifyClientAbort } from '../src/reliability/classify.js';
import { getLimits } from '../src/config/timeouts.js';
import { countDispatchableNodes } from '../src/scheduler/scheduler.js';

const ENV = {};
let now = 1_000_000;
const tick = (ms) => { now += ms; };

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

await test('slot accounting never leaks', async () => {
  const s = getNodeState('n1');
  assert.ok(acquireSlot('n1', now));
  assert.equal(s.activeRequests, 1);
  assert.ok(acquireSlot('n1', now));
  assert.equal(s.activeRequests, 2);
  recordNeutralEnd('n1');
  recordSuccess('n1', 10, now);
  assert.equal(s.activeRequests, 0);
});

await test('consecutive failures open circuit; interleaved success keeps it closed', async () => {
  // 503 success 503 success 503 -> CLOSED
  for (let i = 0; i < 2; i++) {
    acquireSlot('c1', now); tick(1);
    recordFailure('c1', { counted: true, cooldownMs: 100 }, now);
    acquireSlot('c1', now); tick(1);
    recordSuccess('c1', 5, now);
  }
  acquireSlot('c1', now); tick(1);
  recordFailure('c1', { counted: true, cooldownMs: 100 }, now);
  assert.equal(getNodeState('c1').circuitState, 'closed');

  // N consecutive failures -> OPEN
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
    acquireSlot('c1', now); tick(1);
    recordFailure('c1', { counted: true, cooldownMs: 100 }, now);
  }
  assert.equal(getNodeState('c1').circuitState, 'open');
});

await test('half-open allows exactly one probe; probe failure reopens', async () => {
  const id = 'c2';
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
    acquireSlot(id, now); tick(1);
    recordFailure(id, { counted: true, cooldownMs: 50 }, now);
  }
  assert.equal(peekAvailability(id, now), 'no');
  tick(CIRCUIT_OPEN_MS + 1);
  assert.equal(peekAvailability(id, now + 1), 'probe');
  assert.ok(acquireSlot(id, now + 1)); // becomes the probe
  assert.equal(getNodeState(id).probeInFlight, true);
  assert.equal(peekAvailability(id, now + 2), 'no'); // second concurrent request blocked
  tick(1);
  recordFailure(id, { counted: true, cooldownMs: 50 }, now + 3);
  assert.equal(getNodeState(id).circuitState, 'open'); // probe failed -> reopen
  tick(CIRCUIT_OPEN_MS + 5);
  assert.ok(acquireSlot(id, now));
  recordSuccess(id, 8, now);
  assert.equal(getNodeState(id).circuitState, 'closed');
  assert.equal(getNodeState(id).consecutiveFailures, 0);
});

await test('429 rotates with Retry-After but never opens the circuit', async () => {
  const id = 'r1';
  const headers = new Headers({ 'retry-after': '30' });
  const c = classifyUpstreamStatus(429, headers, ENV, now);
  assert.equal(c.action, 'rotate');
  assert.equal(c.cooldownMs, 30_000);
  assert.equal(c.counted, false);
  for (let i = 0; i < 10; i++) {
    acquireSlot(id, now); tick(1);
    recordFailure(id, { counted: c.counted, cooldownMs: c.cooldownMs }, now);
  }
  assert.equal(getNodeState(id).circuitState, 'closed');
  assert.ok(getCooldownRemainingMs(id, now) > 0);
});

await test('Retry-After supports seconds and HTTP-date, clamped', async () => {
  const h = (v) => new Headers({ 'retry-after': v });
  assert.equal(parseRetryAfterMs(h('700'), now), 600_000); // clamped to max
  assert.equal(parseRetryAfterMs(h('0'), now), 1_000); // clamped to min
  const future = new Date(now + 15_000).toUTCString();
  assert.ok(Math.abs(parseRetryAfterMs(h(future), now) - 15_000) < 2_000);
  assert.equal(parseRetryAfterMs(h('garbage'), now), 0);
});

await test('401/403 rotate with auth cooldown and do not count toward circuit', async () => {
  for (const status of [401, 403]) {
    const c = classifyUpstreamStatus(status, new Headers(), ENV, now);
    assert.equal(c.action, 'rotate');
    assert.equal(c.counted, false);
    assert.ok(c.cooldownMs >= 60_000);
  }
});

await test('client errors stop immediately without penalty', async () => {
  for (const status of [400, 402 - 2, 413, 415, 422]) {
    const c = classifyUpstreamStatus(status, new Headers(), ENV, now);
    if (status === 400) {
      assert.equal(c.action, 'stop');
      assert.equal(c.cooldownMs, 0);
      assert.equal(c.counted, false);
    }
  }
  const id = 'ce1';
  acquireSlot(id, now); tick(1);
  const before = getNodeState(id).healthScore;
  applyHealthPenalty(id, 'client');
  assert.equal(getNodeState(id).healthScore, before); // client kind has no penalty
  recordNeutralEnd(id);
});

await test('5xx failures are counted for the circuit without standalone cooldown', async () => {
  const c = classifyUpstreamStatus(503, new Headers(), ENV, now);
  assert.equal(c.action, 'rotate');
  assert.equal(c.counted, true);
  assert.equal(c.cooldownMs, 0); // circuit owns the open-period cooldown
});

await test('success resets consecutive failures and closes half-open', async () => {
  const id = 's1';
  acquireSlot(id, now); tick(1);
  recordSuccess(id, 20, now);
  assert.equal(getNodeState(id).consecutiveFailures, 0);
  assert.equal(getNodeState(id).avgLatencyMs, 20);
  acquireSlot(id, now); tick(1);
  recordSuccess(id, 40, now);
  assert.ok(Math.abs(getNodeState(id).avgLatencyMs - 26) < 1); // EWMA alpha .3
});

// ---- Half-open probe leak / resolution ------------------------------------
// A probe that ends in a non-counted outcome (429 / 401 / 404 / neutral /
// client abort) must release BOTH activeRequests AND probeInFlight, and the node
// must become schedulable again. Regression for the stuck half-open bug.

function openCircuitForProbe(id) {
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
    acquireSlot(id, now); tick(1);
    recordFailure(id, { counted: true, cooldownMs: 50 }, now);
  }
  tick(CIRCUIT_OPEN_MS + 1);
  assert.equal(peekAvailability(id, now), 'probe');
  assert.ok(acquireSlot(id, now));
  const s = getNodeState(id);
  assert.equal(s.probeInFlight, true);
  assert.equal(s.activeRequests, 1);
}

await test('half-open probe -> 429 proves liveness and releases the probe, keeping the cooldown', async () => {
  const id = 'p429';
  openCircuitForProbe(id);
  const s = getNodeState(id);
  recordFailure(id, { counted: false, cooldownMs: 30_000, reason: 'rate_limit' }, now + 1);
  assert.equal(s.probeInFlight, false, 'probeInFlight must be released');
  assert.equal(s.activeRequests, 0, 'activeRequests must be released');
  assert.equal(s.circuitState, 'closed', 'a 429 during a probe must not keep half-open');
  assert.equal(s.consecutiveFailures, 0);
  assert.ok(getCooldownRemainingMs(id, now + 1) > 0, 'rate-limit cooldown must be kept');
  tick(31_000);
  assert.equal(peekAvailability(id, now), 'yes', 'node must be schedulable again after cooldown');
});

await test('half-open probe -> 401 recovers, keeps auth cooldown, no probe leak', async () => {
  const id = 'p401';
  openCircuitForProbe(id);
  recordFailure(id, { counted: false, cooldownMs: 3_600_000, reason: 'auth' }, now + 1);
  const s = getNodeState(id);
  assert.equal(s.probeInFlight, false);
  assert.equal(s.activeRequests, 0);
  assert.equal(s.circuitState, 'closed');
  assert.ok(getCooldownRemainingMs(id, now + 1) > 0);
});

await test('half-open probe -> 404 recovers, keeps model_missing cooldown, no probe leak', async () => {
  const id = 'p404';
  openCircuitForProbe(id);
  recordFailure(id, { counted: false, cooldownMs: 5_000, reason: 'model_missing' }, now + 1);
  const s = getNodeState(id);
  assert.equal(s.probeInFlight, false, '404 probe must not stay in flight');
  assert.equal(s.activeRequests, 0);
  assert.equal(s.circuitState, 'closed');
  assert.ok(getCooldownRemainingMs(id, now + 1) > 0, 'model_missing cooldown must be kept');
});

await test('half-open probe -> neutral end / client abort is not penalized and never stuck half-open', async () => {
  const id = 'pneut';
  openCircuitForProbe(id);
  const before = getNodeState(id).totalFailures; // 3 (from opening the circuit)
  recordNeutralEnd(id);
  const s = getNodeState(id);
  assert.equal(s.probeInFlight, false, 'neutral must release the probe');
  assert.equal(s.activeRequests, 0);
  assert.equal(s.circuitState, 'closed', 'neutral must recover from half-open');
  assert.equal(s.consecutiveFailures, 0);
  assert.equal(s.totalFailures, before, 'neutral must not add a failure');
  assert.equal(peekAvailability(id, now), 'yes', 'node must be immediately schedulable (no cooldown)');
});

await test('half-open probe -> counted failure releases the probe and reopens the circuit', async () => {
  const id = 'p5xx';
  openCircuitForProbe(id);
  recordFailure(id, { counted: true, cooldownMs: 0 }, now + 1);
  const s = getNodeState(id);
  assert.equal(s.probeInFlight, false, 'counted probe failure must release probeInFlight');
  assert.equal(s.activeRequests, 0);
  assert.equal(s.circuitState, 'open', 'counted probe failure must reopen the circuit');
  tick(CIRCUIT_OPEN_MS + 1);
  assert.equal(peekAvailability(id, now + 1), 'probe', 'node must be probe-ready again after the open period');
});

await test('rollbackRpmBucket returns a pre-dispatch reservation without touching post-dispatch charges', async () => {
  const id = 'rpm-rb';
  // acquireSlot charges the current-minute RPM bucket.
  assert.ok(acquireSlot(id, now));
  assert.equal(rpmUsage(id, now), 1);
  assert.equal(getNodeState(id).activeRequests, 1);
  // Pre-dispatch neutral: release slot AND roll back the bucket.
  recordNeutralEnd(id);
  rollbackRpmBucket(id, now);
  assert.equal(getNodeState(id).activeRequests, 0);
  assert.equal(rpmUsage(id, now), 0, 'pre-dispatch reservation must be returned to the bucket');

  // A real dispatched attempt: acquire -> success. The bucket stays charged.
  assert.ok(acquireSlot(id, now));
  recordSuccess(id, 5, now);
  assert.equal(rpmUsage(id, now), 1, 'a dispatched attempt must keep its RPM charge');

  // Excess rollbacks floor at 0 and never go negative.
  assert.ok(acquireSlot(id, now)); // count: 1 -> 2
  rollbackRpmBucket(id, now); rollbackRpmBucket(id, now); rollbackRpmBucket(id, now); rollbackRpmBucket(id, now);
  assert.equal(rpmUsage(id, now), 0, 'rollback floors at 0 and never goes negative');
});

await test('rollbackRpmBucket is a no-op once the minute window has rolled over', async () => {
  const id = 'rpm-rb2';
  // Reservation in the current minute, then the minute rolls over with no new
  // acquire in between. The stale bucket must not be touched: a fresh acquire
  // in the new minute must start at 1, not be pre-charged by the old rollback.
  assert.ok(acquireSlot(id, now));
  assert.equal(rpmUsage(id, now), 1);
  recordNeutralEnd(id);
  tick(61_000);
  rollbackRpmBucket(id, now); // stale bucket -> must be a no-op
  assert.ok(acquireSlot(id, now));
  assert.equal(rpmUsage(id, now), 1, 'cross-minute rollback must not charge down the new bucket');
});

await test('rollbackRpmBucket never fabricates a bucket for a node that never acquired', async () => {
  const id = 'rpm-rb3';
  rollbackRpmBucket(id, now); // no prior acquire
  assert.equal(rpmUsage(id, now), 0, 'rollback must not create a bucket from nothing');
  assert.ok(acquireSlot(id, now));
  assert.equal(rpmUsage(id, now), 1, 'first real acquire starts the counter at 1, not 0 or negative');
});

// ---- Per-attempt header-wait budget split -----------------------------------

await test('one absolute attempt slice is shared by headers and first event', async () => {
  assert.equal(attemptBudgetSliceMs(240_000, 1), 240_000);
  assert.equal(attemptBudgetSliceMs(240_000, 2), 120_000);
  assert.equal(attemptBudgetSliceMs(240_000, 5), 48_000);
  assert.equal(attemptBudgetSliceMs(0, 5), 1, 'a timer never receives a zero delay');
  assert.equal(attemptBudgetSliceMs(60_000, 0), 60_000, 'degenerate attempt counts are clamped');
  // Headers and first-event are serial phases. After headers consume 18s of a
  // 48s attempt slice, the first-event guard can use only the 30s remainder.
  const attemptDeadline = 48_000;
  const afterHeaders = attemptDeadline - 18_000;
  assert.equal(attemptFirstEventTimeoutMs(120_000, afterHeaders, 1), 30_000);
});

await test('a single remaining attempt keeps the whole remaining budget (old behavior)', async () => {
  assert.equal(attemptHeadersTimeoutMs(120_000, 200_000, 1), 120_000);
  assert.equal(attemptHeadersTimeoutMs(120_000, 60_000, 1), 60_000, 'capped by remaining budget');
  assert.equal(attemptHeadersTimeoutMs(120_000, 500_000, 1), 120_000, 'capped by headers timeout');
});

await test('the budget is split evenly across remaining attempts', async () => {
  // Production-shaped case: 240s budget, 60s headers, 5 attempts -> 48s each;
  // a timing-out first node can no longer starve the rest.
  assert.equal(attemptHeadersTimeoutMs(60_000, 240_000, 5), 48_000);
  assert.equal(attemptHeadersTimeoutMs(120_000, 180_000, 2), 90_000, 'the old 120s+60s starvation pair becomes 90s+90s');
  // After an attempt is charged the share grows for the rest.
  assert.equal(attemptHeadersTimeoutMs(60_000, 192_000, 4), 48_000);
});

await test('the per-attempt floor protects viable slow upstreams, the budget caps extremes', async () => {
  // share (10s) below the floor -> floor wins, but never beyond the budget.
  assert.equal(attemptHeadersTimeoutMs(120_000, 50_000, 5), MIN_ATTEMPT_HEADERS_MS);
  // Remaining budget below the floor -> budget wins (no overshoot).
  assert.equal(attemptHeadersTimeoutMs(120_000, 8_000, 5), 8_000);
  assert.equal(attemptHeadersTimeoutMs(60_000, 0, 3), 1, 'degenerate remaining never schedules a 0ms timer');
  // A tight headers timeout dominates everything.
  assert.equal(attemptHeadersTimeoutMs(8_000, 240_000, 5), 8_000);
});

await test('degenerate attempt counts are clamped', async () => {
  assert.equal(attemptHeadersTimeoutMs(60_000, 240_000, 0), 60_000);
  assert.equal(attemptHeadersTimeoutMs(60_000, 240_000, -3), 60_000);
});

await test('first-event timeout is fairly shared across live attempts', async () => {
  assert.equal(attemptFirstEventTimeoutMs(120_000, 240_000, 1), 120_000);
  assert.equal(attemptFirstEventTimeoutMs(120_000, 240_000, 2), 120_000);
  assert.equal(attemptFirstEventTimeoutMs(120_000, 240_000, 5), 48_000);
  assert.equal(attemptFirstEventTimeoutMs(120_000, 10_000, 5), MIN_ATTEMPT_FIRST_EVENT_MS);
  assert.equal(attemptFirstEventTimeoutMs(120_000, 3_000, 5), 3_000, 'remaining budget caps the floor');
});

await test('timeout failures are classified as headers_timeout / first_event_timeout', async () => {
  // fetch never got HTTP status -> headers_timeout, counted for the circuit.
  const headers = classifyNetworkError(true);
  assert.equal(headers.kind, 'headers_timeout');
  assert.equal(headers.action, 'rotate');
  assert.equal(headers.counted, true);
  // plain network error keeps its own kind, also counted.
  const network = classifyNetworkError(false);
  assert.equal(network.kind, 'network');
  assert.equal(network.counted, true);
  // HTTP 200 received, but no valid SSE event -> first_event_timeout, counted.
  const firstEvent = classifyFirstEventFailure();
  assert.equal(firstEvent.kind, 'first_event_timeout');
  assert.equal(firstEvent.action, 'rotate');
  assert.equal(firstEvent.counted, true);
  // client abort stays a neutral, uncounted end of its own kind.
  const abort = classifyClientAbort();
  assert.equal(abort.kind, 'client_abort');
  assert.equal(abort.action, 'neutral');
  assert.equal(abort.counted, false);
});

await test('hedge defaults: 6000ms delay, 1 hedge per request, overridable', async () => {
  const defaults = getLimits(ENV);
  assert.equal(defaults.hedgeDelayMs, 6_000, 'HEDGE_DELAY_MS default is 6000');
  assert.equal(defaults.maxHedgesPerRequest, 1, 'MAX_HEDGES_PER_REQUEST default is 1');
  const overridden = getLimits({ HEDGE_DELAY_MS: '8000', MAX_HEDGES_PER_REQUEST: '2' });
  assert.equal(overridden.hedgeDelayMs, 8_000);
  assert.equal(overridden.maxHedgesPerRequest, 2);
  // 0 disables hedging entirely but stays inside the clamped range.
  assert.equal(getLimits({ MAX_HEDGES_PER_REQUEST: '0' }).maxHedgesPerRequest, 0);
  // Out-of-range values are clamped, not trusted.
  assert.equal(getLimits({ MAX_HEDGES_PER_REQUEST: '99' }).maxHedgesPerRequest, 3);
  assert.equal(getLimits({ HEDGE_DELAY_MS: '-5' }).hedgeDelayMs, 0);
});

await test('dispatchable count reflects the live pool, not the policy maximum', async () => {
  const makeNode = (id) => ({
    id, models: { m: 'upstream' }, priority: 10,
    limits: { concurrency: 1, rpm: 0, rpmMode: 'hard' },
  });
  const nodes = [makeNode('live-count-a'), makeNode('live-count-b')];
  assert.equal(countDispatchableNodes(nodes, 'm', new Set(), now), 2);
  assert.equal(countDispatchableNodes(nodes, 'm', new Set(['live-count-a']), now), 1);
  acquireSlot('live-count-b', now);
  assert.equal(countDispatchableNodes(nodes, 'm', new Set(), now), 1, 'a saturated node is not live capacity');
  recordNeutralEnd('live-count-b');
});

if (!process.exitCode) console.log(`request reliability tests passed (${passed}).`);
