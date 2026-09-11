#!/usr/bin/env node
import fs from 'node:fs';

const path = 'tests/integration-test.mjs';
let source = fs.readFileSync(path, 'utf8');

const startMarker = "await test('concurrency spreads parallel requests across equal nodes'";
const endMarker = "await test('anthropic-route exhaustion errors are Anthropic-shaped'";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker);

if (start < 0 || end < 0 || end <= start) {
  throw new Error('PR #173 integration-contract markers not found');
}

const replacement = String.raw`await test('legacy concurrency is soft: limits.concurrency never hard-blocks the only healthy Tier 1 node', async () => {
  resetMock();
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  routeHandlers['cap-soft.example.com'] = async () => {
    calls++;
    if (calls === 1) await gate;
    return jsonUpstream(okCompletion());
  };
  const env = makeEnv({
    tier1: [basicNode('cap-soft', { limits: { concurrency: 1 } })],
    secrets: { 'cap-soft': 'k' },
  });

  const first = worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  for (let i = 0; i < 100 && upstreamCalls.length < 1; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(upstreamCalls.length, 1, 'first request reached the upstream and is still in flight');

  const second = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(second.status, 200);
  assert.equal(upstreamCalls.length, 2, 'second request is not blocked by legacy concurrency=1');

  releaseFirst();
  const firstRes = await first;
  assert.equal(firstRes.status, 200);
  await firstRes.text();
});

await test('legacy rpm is ignored: repeated requests never synthesize local RPM exhaustion', async () => {
  resetMock();
  routeHandlers['rpm-legacy.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('rpm-legacy', { limits: { concurrency: 1, rpm: 1, rpm_mode: 'hard' } })],
    secrets: { 'rpm-legacy': 'k' },
  });

  for (let i = 0; i < 3; i++) {
    const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
    assert.equal(res.status, 200);
  }
  assert.equal(upstreamCalls.length, 3);
});

await test('legacy QUOTA_RATE_LIMITER binding is not consulted without an active runtime RPM quota', async () => {
  resetMock();
  let limiterCalls = 0;
  const fakeBinding = {
    limit: async () => {
      limiterCalls++;
      return { success: false };
    },
  };
  routeHandlers['legacy-limiter.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('legacy-limiter', { limits: { rpm: 1 } })],
    secrets: { 'legacy-limiter': 'k' },
    extraEnv: { QUOTA_RATE_LIMITER: fakeBinding },
  });

  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.equal(limiterCalls, 0);
  assert.equal(upstreamCalls.length, 1);
});

await test('legacy limits do not block a healthy Tier 2 fallback', async () => {
  resetMock();
  routeHandlers['legacy-t1.example.com'] = () => jsonUpstream({}, 502);
  routeHandlers['legacy-t2.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('legacy-t1')],
    tier2: [basicNode('legacy-t2', { limits: { concurrency: 1, rpm: 1, rpm_mode: 'hard' } })],
    secrets: { 'legacy-t1': 'k', 'legacy-t2': 'k' },
    extraEnv: {
      MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'fast' } }),
      POLICIES_CONFIG: JSON.stringify({ fast: { max_attempts: 2 } }),
    },
  });

  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((call) => call.host), [
    'legacy-t1.example.com',
    'legacy-t2.example.com',
  ]);
});

await test('busy Tier 2 remains last-resort capacity despite legacy concurrency=1', async () => {
  resetMock();
  let releaseParked;
  const gate = new Promise((resolve) => { releaseParked = resolve; });
  let tier2Calls = 0;
  routeHandlers['busy-t2.example.com'] = async () => {
    tier2Calls++;
    if (tier2Calls === 1) await gate;
    return jsonUpstream(okCompletion());
  };
  routeHandlers['busy-t1.example.com'] = () => jsonUpstream({}, 502);

  const env = makeEnv({
    tier1: [basicNode('busy-t1', { models: { 'general-air': 'm' } })],
    tier2: [basicNode('busy-t2', {
      limits: { concurrency: 1 },
      models: { 'general-air': 'm', 'sat-model': 'm' },
    })],
    secrets: { 'busy-t1': 'k', 'busy-t2': 'k' },
    extraEnv: {
      EXPOSE_UPSTREAM_INFO: 'true',
      MODELS_CONFIG: JSON.stringify({
        'general-air': { policy: 'fast' },
        'sat-model': { policy: 'fast' },
      }),
      POLICIES_CONFIG: JSON.stringify({ fast: { max_attempts: 2 } }),
    },
  });

  const parked = worker.fetch(chatRequest({ model: 'sat-model', messages: [] }), env, {});
  for (let i = 0; i < 100 && tier2Calls < 1; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(tier2Calls, 1, 'first Tier 2 request is parked in flight');

  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-node'), 'busy-t2');
  assert.equal(tier2Calls, 2, 'busy Tier 2 node remains usable as the only healthy fallback');

  releaseParked();
  const parkedRes = await parked;
  assert.equal(parkedRes.status, 200);
  await parkedRes.text();
});

`;

source = source.slice(0, start) + replacement + source.slice(end);
source = source.replace(
  "import { __resetAllStateForTests, getNodeState, noteRpmRequest } from '../src/reliability/node-state.ts';",
  "import { __resetAllStateForTests, getNodeState } from '../src/reliability/node-state.ts';",
);
source = source.replace(
  '  getTier1Account, getTier1Model, snapshotTier1Runtime, recordTier1Ttft, tier1RpmUsage,',
  '  getTier1Account, getTier1Model, snapshotTier1Runtime, recordTier1Ttft,',
);

fs.writeFileSync(path, source);
console.log('PR #173 integration contracts updated.');
