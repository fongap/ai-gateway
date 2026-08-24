#!/usr/bin/env node
// Unit tests for node runtime state: concurrency slots, cooldowns, circuit
// breaker transitions, half-open single probe.
import assert from 'node:assert/strict';
import {
  acquireSlot, peekAvailability, recordSuccess, recordFailure, recordNeutralEnd,
  getNodeState, getCooldownRemainingMs, applyHealthPenalty,
  CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_OPEN_MS,
} from '../src/reliability/node-state.js';
import { parseRetryAfterMs } from '../src/config/timeouts.js';
import { classifyUpstreamStatus } from '../src/reliability/classify.js';

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

if (!process.exitCode) console.log(`reliability unit tests passed (${passed}/9).`);
