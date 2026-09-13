#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  acquireSlot,
  peekAvailability,
  recordSuccess,
  recordFailure,
  recordNeutralEnd,
  recordModelMissing,
  isModelCooling,
  getNodeState,
  getCooldownRemainingMs,
  applyHealthPenalty,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_OPEN_MS,
  __resetAllStateForTests,
} from '../src/reliability/node-state.ts';
import {
  parseRetryAfterMs,
  attemptBudgetSliceMs,
  attemptHeadersTimeoutMs,
  attemptFirstEventTimeoutMs,
  MIN_ATTEMPT_HEADERS_MS,
  MIN_ATTEMPT_FIRST_EVENT_MS,
} from '../src/config/timeouts.ts';
import {
  classifyUpstreamStatus,
  classifyNetworkError,
  classifyFirstEventFailure,
  classifyClientAbort,
  classifyPreDispatchRateLimit,
  classifyPreDispatchInvalidBaseUrl,
  classifyStreamInterrupted,
  classifyHedgeRaceLoss,
  classifyHedgeUnknown,
  classifyNonJsonBody,
  KIND,
} from '../src/reliability/classify.ts';

const ENV = {};
let now = 1_000_000;
const tick = (ms) => { now += ms; };

let passed = 0;
async function test(name, fn) {
  try {
    __resetAllStateForTests();
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

await test('live slot accounting releases exactly what was claimed', async () => {
  const state = getNodeState('n1');
  assert.ok(acquireSlot('n1', now));
  assert.ok(acquireSlot('n1', now));
  assert.equal(state.activeRequests, 2);
  recordNeutralEnd('n1');
  recordSuccess('n1', 10, 'model-a', now);
  assert.equal(state.activeRequests, 0);
  assert.equal(state.totalRequests, 2);
  assert.equal(state.totalSuccesses, 1);
});

await test('there is no static concurrency admission ceiling', async () => {
  for (let i = 0; i < 6; i++) assert.ok(acquireSlot('busy', now));
  assert.equal(getNodeState('busy').activeRequests, 6);
  for (let i = 0; i < 6; i++) recordNeutralEnd('busy');
  assert.equal(getNodeState('busy').activeRequests, 0);
});

await test('consecutive counted failures open the circuit; success resets it', async () => {
  const id = 'c1';
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
    assert.ok(acquireSlot(id, now));
    tick(1);
    recordFailure(id, { counted: true, cooldownMs: 0, reason: 'server' }, now);
  }
  assert.equal(getNodeState(id).circuitState, 'open');
  tick(CIRCUIT_OPEN_MS + 1);
  assert.equal(peekAvailability(id, now), 'probe');
  assert.ok(acquireSlot(id, now));
  recordSuccess(id, 8, 'model-a', now);
  assert.equal(getNodeState(id).circuitState, 'closed');
  assert.equal(getNodeState(id).consecutiveFailures, 0);
});

await test('half-open permits one live probe and a counted probe failure reopens', async () => {
  const id = 'half';
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
    acquireSlot(id, now);
    recordFailure(id, { counted: true, cooldownMs: 0, reason: 'server' }, now);
  }
  tick(CIRCUIT_OPEN_MS + 1);
  assert.equal(peekAvailability(id, now), 'probe');
  assert.ok(acquireSlot(id, now));
  assert.equal(peekAvailability(id, now), 'no');
  recordFailure(id, { counted: true, cooldownMs: 0, reason: 'server' }, now);
  assert.equal(getNodeState(id).circuitState, 'open');
  assert.equal(getNodeState(id).probeInFlight, false);
  assert.equal(getNodeState(id).activeRequests, 0);
});

await test('non-counted probe outcomes release half-open without leaking the slot', async () => {
  const id = 'probe-neutral';
  for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) {
    acquireSlot(id, now);
    recordFailure(id, { counted: true, cooldownMs: 0, reason: 'server' }, now);
  }
  tick(CIRCUIT_OPEN_MS + 1);
  assert.ok(acquireSlot(id, now));
  recordFailure(id, { counted: false, cooldownMs: 30_000, reason: 'rate_limit' }, now);
  const state = getNodeState(id);
  assert.equal(state.circuitState, 'closed');
  assert.equal(state.probeInFlight, false);
  assert.equal(state.activeRequests, 0);
  assert.ok(getCooldownRemainingMs(id, now) > 0);
});

await test('model_missing cooldown is scoped to the node/model pair', async () => {
  const id = 'model-scope';
  acquireSlot(id, now);
  recordModelMissing(id, 'Max', 5_000, now);
  assert.equal(isModelCooling(id, 'Max', now), true);
  assert.equal(isModelCooling(id, 'Pro', now), false);
  assert.equal(getNodeState(id).activeRequests, 0);
});

await test('429 respects Retry-After and never counts toward the circuit', async () => {
  const classification = classifyUpstreamStatus(429, new Headers({ 'retry-after': '30' }), ENV, now);
  assert.equal(classification.kind, KIND.RATE_LIMIT);
  assert.equal(classification.action, 'rotate');
  assert.equal(classification.cooldownMs, 30_000);
  assert.equal(classification.counted, false);
});

await test('Retry-After seconds and HTTP-date are parsed and clamped', async () => {
  const header = (value) => new Headers({ 'retry-after': value });
  assert.equal(parseRetryAfterMs(header('700'), now), 600_000);
  assert.equal(parseRetryAfterMs(header('0'), now), 1_000);
  const future = new Date(now + 15_000).toUTCString();
  assert.ok(Math.abs(parseRetryAfterMs(header(future), now) - 15_000) < 2_000);
  assert.equal(parseRetryAfterMs(header('garbage'), now), 0);
});

await test('auth responses rotate with cooldown without circuit penalty', async () => {
  for (const status of [401, 403]) {
    const c = classifyUpstreamStatus(status, new Headers(), ENV, now);
    assert.equal(c.kind, KIND.AUTH);
    assert.equal(c.action, 'rotate');
    assert.equal(c.counted, false);
    assert.ok(c.cooldownMs >= 60_000);
  }
});

await test('client errors stop without node penalty', async () => {
  for (const status of [400, 413, 415, 422]) {
    const c = classifyUpstreamStatus(status, new Headers(), ENV, now);
    assert.equal(c.action, 'stop');
    assert.equal(c.counted, false);
  }
  acquireSlot('client', now);
  const before = getNodeState('client').healthScore;
  applyHealthPenalty('client', 'client');
  assert.equal(getNodeState('client').healthScore, before);
  recordNeutralEnd('client');
});

await test('5xx and network/timeout failures are counted transient failures', async () => {
  const server = classifyUpstreamStatus(503, new Headers(), ENV, now);
  assert.equal(server.kind, KIND.SERVER);
  assert.equal(server.counted, true);
  assert.equal(classifyNetworkError(false).kind, KIND.NETWORK);
  assert.equal(classifyNetworkError(true).kind, KIND.HEADERS_TIMEOUT);
  assert.equal(classifyFirstEventFailure().kind, KIND.FIRST_EVENT_TIMEOUT);
});

await test('HTTP 200 invalid protocol body is counted with a short cooldown', async () => {
  const c = classifyNonJsonBody();
  assert.equal(c.kind, KIND.NON_JSON_BODY);
  assert.equal(c.action, 'rotate');
  assert.equal(c.counted, true);
  assert.equal(c.cooldownMs, 5_000);
});

await test('client abort and hedge race loss are neutral', async () => {
  assert.equal(classifyClientAbort().action, 'neutral');
  assert.equal(classifyHedgeRaceLoss().action, 'neutral');
  assert.equal(classifyHedgeUnknown().action, 'rotate');
});

await test('pre-dispatch denials are not node failures', async () => {
  assert.equal(classifyPreDispatchRateLimit().kind, KIND.RATE_LIMIT_GLOBAL);
  assert.equal(classifyPreDispatchRateLimit().counted, false);
  assert.equal(classifyPreDispatchInvalidBaseUrl().kind, KIND.INVALID_BASE_URL);
});

await test('stream interruption is counted and receives recovery cooldown', async () => {
  const c = classifyStreamInterrupted();
  assert.equal(c.kind, KIND.STREAM_INTERRUPTED);
  assert.equal(c.counted, true);
  assert.equal(c.cooldownMs, 60_000);
});

await test('one absolute attempt slice is shared by headers and first event', async () => {
  assert.equal(attemptBudgetSliceMs(240_000, 1), 240_000);
  assert.equal(attemptBudgetSliceMs(240_000, 2), 120_000);
  assert.equal(attemptBudgetSliceMs(240_000, 5), 48_000);
  assert.equal(attemptBudgetSliceMs(0, 5), 1);
  assert.equal(attemptFirstEventTimeoutMs(120_000, 30_000, 1), 30_000);
});

await test('attempt phase timeouts honor remaining attempt budget', async () => {
  assert.equal(attemptHeadersTimeoutMs(120_000, 60_000, 1), 60_000);
  assert.equal(attemptFirstEventTimeoutMs(120_000, 60_000, 1), 60_000);
  assert.ok(MIN_ATTEMPT_HEADERS_MS > 0);
  assert.ok(MIN_ATTEMPT_FIRST_EVENT_MS > 0);
});

if (!process.exitCode) console.log(`request-reliability tests passed (${passed}).`);
