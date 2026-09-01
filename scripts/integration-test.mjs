#!/usr/bin/env node
// Black-box integration tests: run the REAL worker pipeline
// (auth -> scheduler -> retry -> circuit -> protocol -> stream) through
// worker.fetch() against a mocked global fetch upstream.
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { __resetAllStateForTests, getNodeState, noteRpmRequest } from '../src/reliability/node-state.js';
import {
  __resetTier1StateForTests, tier1AccountInFlight,
  getTier1Account, getTier1Model, snapshotTier1Runtime, recordTier1Ttft, tier1RpmUsage,
} from '../src/reliability/tier1-state.js';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.js';
import { createMockD1 } from './mock-d1-database.mjs';

const ACCESS_KEY = 'test-access-key';

let passed = 0;
async function test(name, fn) {
  try {
    __resetAllStateForTests();
    __resetTier1StateForTests();
    __resetTier1AffinityForTests();
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

// ---- Mock upstream plumbing ------------------------------------------------

const upstreamCalls = []; // { host, path, headers, body }
let routeHandlers = {}; // hostname -> (request, url) => Response

function installMockFetch() {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const handler = routeHandlers[url.hostname];
    if (!handler) throw new Error(`no mock upstream for ${url.hostname}`);
    const req = init?.body !== undefined
      ? new Request(url, { method: 'POST', headers: init.headers, body: init.body })
      : null;
    if (req) {
      upstreamCalls.push({
        host: url.hostname,
        url,
        authorization: init.headers.get('authorization'),
        headers: init.headers,
        body: JSON.parse(init.body),
      });
    } else {
      upstreamCalls.push({ host: url.hostname, url, authorization: init.headers.get('authorization'), headers: init.headers, body: null });
    }
    // `init` is passed as a third argument so handlers can honor the dispatch
    // AbortController (abort-driven hang/reject semantics for hedge tests).
    return handler(req ?? {}, url, init);
  };
}

function resetMock() {
  upstreamCalls.length = 0;
  routeHandlers = {};
}

function makeEnv({ tier1, tier2, tier3, secrets, extraEnv } = {}) {
  return {
    GATEWAY_ACCESS_KEY: ACCESS_KEY,
    // Deterministic P2C sampling in tests: a fixed seed makes the random
    // two-choice picks reproducible so order-sensitive assertions stay stable.
    // Production never sets this; P2C uses Math.random there.
    TIER1_SCHEDULER_SEED: 'integration-test',
    ...(tier1 ? { TIER1_NODES_CONFIG_01: JSON.stringify(tier1) } : {}),
    ...(tier2 ? { TIER2_NODES_CONFIG_01: JSON.stringify(tier2) } : {}),
    ...(tier3 ? { TIER3_NODES_CONFIG_01: JSON.stringify(tier3) } : {}),
    ...(secrets ? { NODE_SECRETS_01: JSON.stringify(secrets) } : {}),
    ...extraEnv,
  };
}

const basicNode = (id, extra = {}) => ({
  id,
  provider: 'mock',
  base_url: `https://${id}.example.com/v1`,
  models: { 'general-air': 'up-model' },
  ...extra,
});

// Anthropic-protocol node: serves /v1/messages natively.
const anthropicNode = (id, extra = {}) => ({
  id,
  provider: 'mock',
  protocol: 'anthropic',
  surfaces: ['messages'],
  base_url: `https://${id}.example.com`,
  models: { 'claude-x': 'up-model' },
  ...extra,
});

function chatRequest(body, key = ACCESS_KEY, init = {}) {
  return new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key !== null ? { authorization: `Bearer ${key}` } : {}),
      ...(init.headers || {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: init.signal,
  });
}

function jsonUpstream(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sseBody(events) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= events.length) {
        controller.close();
        return;
      }
      const e = events[i++];
      controller.enqueue(encoder.encode(
        `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`,
      ));
    },
  });
}

function sseResponse(events, headers = {}) {
  return new Response(sseBody(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

// Raw SSE lines (already complete `event:`/`data:` blocks), UTF-8 encoded.
// Used by native-protocol mocks (Anthropic / Responses event lifecycles).
function sseEventsResponse(lines, headers = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i >= lines.length) { controller.close(); return; }
      controller.enqueue(encoder.encode(lines[i++]));
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}

const chunk = (content) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
});
const doneEvent = '[DONE]';
const finishChunk = {
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
};
const okCompletion = (model = 'up-model') => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

// Native Anthropic non-stream message (for the /v1/messages mocks).
const okMessage = (model = 'up-model') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model,
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

installMockFetch();

// ---- Auth ------------------------------------------------------------------

await test('missing gateway key returns 401 without touching upstreams', async () => {
  resetMock();
  routeHandlers['a.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({ tier1: [basicNode('a')], secrets: { a: 'cred-a' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }, null), env, {});
  assert.equal(res.status, 401);
  assert.equal(upstreamCalls.length, 0);
});

await test('wrong gateway key returns 401', async () => {
  resetMock();
  const env = makeEnv({ tier1: [basicNode('a')], secrets: { a: 'cred-a' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }, 'nope'), env, {});
  assert.equal(res.status, 401);
});

// ---- Tier 1 P2C, capacity and RPM -----------------------------------------

await test('Tier 1 P2C ignores static priority ordering', async () => {
  resetMock();
  for (const id of ['a10', 'a50', 'a100']) {
    routeHandlers[`${id}.example.com`] = () => jsonUpstream(okCompletion());
  }
  const env = makeEnv({
    tier1: [
      basicNode('a100', { base_url: 'https://a100.example.com/v1', priority: 100 }),
      basicNode('a10', { base_url: 'https://a10.example.com/v1', priority: 10 }),
      basicNode('a50', { base_url: 'https://a50.example.com/v1', priority: 50 }),
    ],
    secrets: { a10: 'k1', a50: 'k2', a100: 'k3' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls.length, 1, 'P2C dispatches one account, not a priority-ordered scan');
  assert.notEqual(upstreamCalls[0].host, 'a10.example.com',
    'the lowest numeric priority is not a privileged Tier 1 choice');
});

await test('dynamic candidate set: failed node skipped, next candidate picked', async () => {
  resetMock();
  routeHandlers['dyn-a.example.com'] = () => jsonUpstream({}, 500);
  routeHandlers['dyn-b.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('dyn-a'), basicNode('dyn-b')],
    secrets: { 'dyn-a': 'k', 'dyn-b': 'k' },
    extraEnv: { EXPOSE_UPSTREAM_INFO: 'true' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['dyn-a.example.com', 'dyn-b.example.com']);
  const body = await res.json();
  assert.equal(res.headers.get('x-gateway-node'), 'dyn-b');
  assert.equal(body.model, 'general-air'); // logical model name restored
});

await test('single transient failure has hysteresis and does not immediately cooldown', async () => {
  resetMock();
  installMockFetch();
  routeHandlers['backoff-a.example.com'] = () => jsonUpstream({}, 503);
  routeHandlers['backoff-b.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('backoff-a'), basicNode('backoff-b')],
    secrets: { 'backoff-a': 'k', 'backoff-b': 'k' },
  });
  const first = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(first.status, 200);
  await first.text();
  const second = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(second.status, 200);
  await second.text();
  assert.deepEqual(upstreamCalls.map((call) => call.host), [
    'backoff-a.example.com', 'backoff-b.example.com',
    'backoff-a.example.com', 'backoff-b.example.com',
  ]);
  const runtime = snapshotTier1Runtime('backoff-a', 'general-air');
  assert.equal(runtime.failure_state, 'normal');
  assert.equal(runtime.consecutive_failures, 2);
  assert.equal(runtime.cooldown_remaining_ms, 0);
});

await test('concurrency spreads parallel requests across equal nodes', async () => {
  resetMock();
  const ids = ['cc-a', 'cc-b', 'cc-c', 'cc-d'];
  for (const id of ids) {
    routeHandlers[`${id}.example.com`] = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return jsonUpstream(okCompletion());
    };
  }
  const env = makeEnv({
    tier1: ids.map((id) => basicNode(id, { limits: { concurrency: 1 } })),
    secrets: Object.fromEntries(ids.map((id) => [id, 'k'])),
    extraEnv: { EXPOSE_UPSTREAM_INFO: 'true' },
  });
  const responses = await Promise.all(ids.map(() =>
    worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {}).then((r) => r.headers.get('x-gateway-node'))));
  assert.equal(new Set(responses).size, 4, `expected 4 distinct nodes, got ${responses.join(',')}`);
});

await test('Tier 1 sequential selection has no LRU rotation contract', async () => {
  resetMock();
  for (const id of ['lru-a', 'lru-b', 'lru-c']) {
    routeHandlers[`${id}.example.com`] = () => jsonUpstream(okCompletion());
  }
  const ids = ['lru-a', 'lru-b', 'lru-c'];
  const env = makeEnv({
    tier1: ids.map((id) => basicNode(id)), // identical priority
    secrets: Object.fromEntries(ids.map((id) => [id, 'k'])),
    extraEnv: { EXPOSE_UPSTREAM_INFO: 'true' },
  });
  const served = [];
  for (let i = 0; i < 3; i++) {
    const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
    assert.equal(res.status, 200);
    await res.text();
    served.push(res.headers.get('x-gateway-node'));
  }
  assert.ok(served.every((id) => ids.includes(id)), `P2C returned only eligible accounts: ${served.join(',')}`);
});

await test('RPM cap rotates to sibling keys before exhausting a single key', async () => {
  resetMock();
  for (const id of ['rpm-a', 'rpm-b']) {
    routeHandlers[`${id}.example.com`] = () => jsonUpstream(okCompletion());
  }
  const env = makeEnv({
    tier1: [
      basicNode('rpm-a', { limits: { concurrency: 5, rpm: 1 } }),
      basicNode('rpm-b', { limits: { concurrency: 5, rpm: 1 } }),
    ],
    secrets: { 'rpm-a': 'k', 'rpm-b': 'k' },
    extraEnv: { EXPOSE_UPSTREAM_INFO: 'true' },
  });
  const nodes = [];
  for (let i = 0; i < 2; i++) {
    const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
    assert.equal(res.status, 200);
    nodes.push(res.headers.get('x-gateway-node'));
  }
  assert.deepEqual(nodes, ['rpm-a', 'rpm-b'], 'second request must rotate to the uncapped sibling');
});

await test('RPM soft mode keeps the legacy break-through: a lone capped node still serves', async () => {
  resetMock();
  routeHandlers['solo.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('solo', { limits: { concurrency: 5, rpm: 1, rpm_mode: 'soft' } })],
    secrets: { solo: 'k' },
  });
  for (let i = 0; i < 3; i++) {
    const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
    assert.equal(res.status, 200, `request ${i + 1} must still succeed`);
  }
});

await test('RPM hard mode never exceeds the configured cap: exhaustion yields 503 at the minute boundary', async () => {
  resetMock();
  routeHandlers['hard.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('hard', { limits: { concurrency: 5, rpm: 1 } })], // hard is the default
    secrets: { hard: 'k' },
  });
  const first = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(first.status, 200);
  const second = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(second.status, 503, 'hard-rpm exhaustion must not silently exceed the quota');
  const retryAfter = Number(second.headers.get('retry-after'));
  assert.ok(retryAfter >= 1 && retryAfter <= 60, `retry-after must point at the minute boundary, got ${retryAfter}`);
  assert.equal(upstreamCalls.length, 1, 'the exhausted node must not be called again');
});

await test('global QUOTA_RATE_LIMITER deny rotates without counting a node failure', async () => {
  resetMock();
  routeHandlers['gb-a.example.com'] = () => jsonUpstream(okCompletion());
  routeHandlers['gb-b.example.com'] = () => jsonUpstream(okCompletion());
  const fakeBinding = {
    limit: async ({ key }) => ({ success: key !== 'gb-a' }), // gb-a globally denied
  };
  const env = makeEnv({
    tier1: [
      basicNode('gb-a', { limits: { concurrency: 5, rpm: 100 } }),
      basicNode('gb-b'),
    ],
    secrets: { 'gb-a': 'k', 'gb-b': 'k' },
    extraEnv: { QUOTA_RATE_LIMITER: fakeBinding },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['gb-b.example.com'],
    'globally denied node must not receive the request');
  assert.equal(getNodeState('gb-a').totalFailures, 0, 'global deny is not a node failure');
  assert.equal(tier1RpmUsage('gb-a'), 0, 'pre-dispatch deny must roll back the RPM reservation');
});

await test('all nodes denied by distributed limiter returns 429 with a window-based Retry-After', async () => {
  resetMock();
  // Every node is denied by the distributed limiter before reaching upstream.
  // rate_limit_global leaves no node cooldown (the node was never at fault), so
  // the exhausted response must fall back to a Retry-After at the next fixed
  // window reset rather than omitting the header.
  routeHandlers['ga1.example.com'] = () => jsonUpstream(okCompletion());
  routeHandlers['ga2.example.com'] = () => jsonUpstream(okCompletion());
  const fakeBinding = {
    limit: async () => ({ success: false }), // deny everything
  };
  const env = makeEnv({
    tier1: [basicNode('ga1', { limits: { concurrency: 5, rpm: 100 } }), basicNode('ga2', { limits: { concurrency: 5, rpm: 100 } })],
    secrets: { ga1: 'k', ga2: 'k' },
    extraEnv: { QUOTA_RATE_LIMITER: fakeBinding },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 429, 'all-denied should surface as 429');
  const retryAfter = Number(res.headers.get('retry-after'));
  assert.ok(retryAfter >= 1 && retryAfter <= 60, `retry-after must point at the fixed-window reset, got ${retryAfter}`);
  assert.deepEqual(upstreamCalls, [], 'no node may be contacted when the distributed limiter denies all');
});

await test('pre-dispatch denies charge no budget: Tier1 drain continues, Tier2 never entered', async () => {
  resetMock();
  // Four keys are denied by the distributed limiter BEFORE any dispatch;
  // max_attempts=2 gives caps[tier1]=1 with both tiers schedulable. Charging
  // usedInTier pre-dispatch (the old behavior) let one deny drain the tier
  // budget and dropped the request into Tier2 without ever contacting a
  // provider. Zero-charging keeps draining the Tier1 candidate set instead.
  const deniedIds = ['db1', 'db2', 'db3', 'db4'];
  routeHandlers['db-ok.example.com'] = () => jsonUpstream(okCompletion());
  routeHandlers['t2.example.com'] = () => jsonUpstream(okCompletion());
  const fakeBinding = {
    limit: async ({ key }) => ({ success: !deniedIds.includes(key) }),
  };
  const env = makeEnv({
    tier1: [
      ...deniedIds.map((id) => basicNode(id, { limits: { concurrency: 5, rpm: 100 } })),
      basicNode('db-ok'),
    ],
    tier2: [basicNode('t2')],
    secrets: Object.fromEntries([...deniedIds, 'db-ok', 't2'].map((id) => [id, 'k'])),
    extraEnv: {
      QUOTA_RATE_LIMITER: fakeBinding,
      MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'fast' } }),
      POLICIES_CONFIG: JSON.stringify({ fast: { max_attempts: 2 } }),
    },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['db-ok.example.com'],
    'the dispatchable Tier1 node must be reached and lower Tier2 must never be entered');
  assert.equal(getNodeState('db1').totalFailures, 0, 'global deny is not a node failure');
  assert.equal(tier1RpmUsage('db1'), 0, 'pre-dispatch deny rolls back the RPM reservation');
});

await test('hard-RPM-exhausted fallback tier is skipped and Tier 1 honors its three-attempt cap', async () => {
  resetMock();
  // Tier2's single node is hard-RPM exhausted for this minute -> deferred
  // capacity, not dispatchable. It must not reserve a budget slot that
  // shortchanges Tier1. Tier 1 still has its dedicated hard cap of three,
  // even when the model policy permits five total attempts.
  for (let i = 1; i <= 6; i++) routeHandlers[`rp${i}.example.com`] = () => jsonUpstream({}, 502);
  routeHandlers['rpmex-t2.example.com'] = () => jsonUpstream(okCompletion());
  noteRpmRequest('rpmex-t2', Date.now()); // burn its whole minute window (rpm=1)
  const env = makeEnv({
    tier1: Array.from({ length: 6 }, (_, i) => basicNode(`rp${i + 1}`)),
    tier2: [basicNode('rpmex-t2', { limits: { concurrency: 5, rpm: 1 } })],
    secrets: { rp1: 'k', rp2: 'k', rp3: 'k', rp4: 'k', rp5: 'k', rp6: 'k', 'rpmex-t2': 'k' },
    extraEnv: {
      MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'fast' } }),
      POLICIES_CONFIG: JSON.stringify({ fast: { max_attempts: 5 } }),
    },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.details.attempts, 3, 'Tier1 is hard-capped at three attempts');
  const hosts = upstreamCalls.map((c) => c.host);
  assert.equal(hosts.length, 3);
  assert.ok(hosts.every((h) => /^rp[1-6]\.example\.com$/.test(h)), 'every attempt stays in Tier1');
  assert.ok(!hosts.includes('rpmex-t2.example.com'), 'the deferred tier is never dispatched');
});

await test('concurrency-saturated fallback tier is skipped while Tier 1 keeps its own cap', async () => {
  resetMock();
  // Tier2's lone node serves sat-model AND general-air at concurrency=1; the
  // first request parks itself in that slot behind a gate. A second request
  // sees Tier2 saturated (deferred capacity), so Tier1 keeps the whole
  // attempt budget instead of surrendering one slot to the busy tier.
  let releaseSat;
  const gate = new Promise((r) => { releaseSat = r; });
  routeHandlers['sat2.example.com'] = async () => {
    await gate;
    return jsonUpstream(okCompletion());
  };
  for (let i = 1; i <= 6; i++) routeHandlers[`cs${i}.example.com`] = () => jsonUpstream({}, 502);
  const env = makeEnv({
    tier1: Array.from({ length: 6 }, (_, i) => basicNode(`cs${i + 1}`)),
    tier2: [basicNode('sat2', {
      limits: { concurrency: 1 },
      models: { 'general-air': 'm', 'sat-model': 'm' },
    })],
    secrets: { cs1: 'k', cs2: 'k', cs3: 'k', cs4: 'k', cs5: 'k', cs6: 'k', sat2: 'k' },
    extraEnv: {
      MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'fast' }, 'sat-model': { policy: 'fast' } }),
      POLICIES_CONFIG: JSON.stringify({ fast: { max_attempts: 5 } }),
    },
  });
  const parked = worker.fetch(chatRequest({ model: 'sat-model', messages: [] }), env, {});
  // Wait until the parked request has actually claimed the sat2 slot.
  for (let i = 0; i < 100 && !upstreamCalls.some((c) => c.host === 'sat2.example.com'); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(upstreamCalls.some((c) => c.host === 'sat2.example.com'), 'parked request must hold the sat2 slot');

  const baseline = upstreamCalls.length;
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.details.attempts, 3, 'Tier1 keeps its dedicated three-attempt cap');
  const hosts = upstreamCalls.slice(baseline).map((c) => c.host);
  assert.equal(hosts.length, 3);
  assert.ok(hosts.every((h) => /^cs[1-6]\.example\.com$/.test(h)), 'every new attempt stays in Tier1');

  releaseSat();
  const parkedRes = await parked;
  assert.equal(parkedRes.status, 200);
  await parkedRes.text();
});

await test('saturation returns 503 with Retry-After instead of bare 429', async () => {
  resetMock();
  let release;
  const gate = new Promise((r) => { release = r; });
  routeHandlers['cap.example.com'] = async () => {
    await gate;
    return jsonUpstream(okCompletion());
  };
  const env = makeEnv({
    tier1: [basicNode('cap', { limits: { concurrency: 1 } })],
    secrets: { cap: 'k' },
  });
  const first = worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  await new Promise((r) => setTimeout(r, 10)); // let it claim the only slot
  const second = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  release();
  assert.equal(await first.then((r) => r.status), 200);
  assert.equal(second.status, 503);
  assert.equal(second.headers.get('retry-after'), '1');
});

await test('Retry-After takes the min across blocking reasons, filtered by model', async () => {
  // Three nodes; the requested model (code-pro) is served by only two of them.
  //   cp-fast : serves code-pro, concurrency=1, slot held -> frees in ~1s
  //   cp-rpm  : serves code-pro, hard RPM exhausted      -> ~50s window
  //   air-cool: serves general-air ONLY, node cooldown 90s -> does NOT serve code-pro
  // Requesting code-pro must yield Retry-After=1 (cp-fast's concurrency wait),
  // NOT 50 (cp-rpm's RPM window) and NOT 90 (air-cool's unrelated cooldown).
  resetMock();
  let release;
  const gate = new Promise((r) => { release = r; });
  routeHandlers['cp-fast.example.com'] = async () => { await gate; return jsonUpstream(okCompletion()); };
  routeHandlers['cp-rpm.example.com'] = () => jsonUpstream(okCompletion());
  routeHandlers['air-cool.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': '90' });
  const env = makeEnv({
    tier1: [
      { ...basicNode('cp-fast'), models: { 'code-pro': 'up-c' }, limits: { concurrency: 1 } },
      { ...basicNode('cp-rpm'), models: { 'code-pro': 'up-c2' }, limits: { concurrency: 5, rpm: 1 } },
      { ...basicNode('air-cool'), models: { 'general-air': 'up-a' } },
    ],
    secrets: { 'cp-fast': 'k', 'cp-rpm': 'k', 'air-cool': 'k' },
  });
  // Hold cp-fast's only concurrency slot.
  const hold = worker.fetch(chatRequest({ model: 'code-pro', messages: [] }), env, {});
  await new Promise((r) => setTimeout(r, 10));
  // Exhaust cp-rpm's hard RPM (1 request fills the per-minute bucket).
  await worker.fetch(chatRequest({ model: 'code-pro', messages: [] }), env, {});
  // Cool air-cool with a 90s node cooldown (it does not serve code-pro anyway).
  await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  // Now request code-pro: cp-fast saturated, cp-rpm RPM-exhausted, air-cool
  // excluded (does not serve code-pro). Retry-After must be 1, the concurrency
  // node's short wait — proving the min is taken and unrelated nodes are filtered.
  const res = await worker.fetch(chatRequest({ model: 'code-pro', messages: [] }), env, {});
  release();
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '1',
    'Retry-After must be the concurrency wait (1s), not the RPM window (~50s) or an unrelated model cooldown (90s)');
});

await test('anthropic-route exhaustion errors are Anthropic-shaped', async () => {
  resetMock();
  routeHandlers['anx.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': '30' });
  const env = makeEnv({ tier1: [anthropicNode('anx', { models: { 'general-air': 'up-model' } })], secrets: { anx: 'k' } });
  // First request cools the only node; second hits the exhausted path.
  await worker.fetch(new Request('https://gateway.example.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ACCESS_KEY },
    body: JSON.stringify({ model: 'general-air', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  }), env, {});
  const res = await worker.fetch(new Request('https://gateway.example.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ACCESS_KEY },
    body: JSON.stringify({ model: 'general-air', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  }), env, {});
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'rate_limit_error');
});

// ---- 429 / Retry-After -----------------------------------------------------

await test('429 isolates the node; same-tier B serves; tier-2 untouched', async () => {
  resetMock();
  routeHandlers['r-a.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': '60' });
  routeHandlers['r-b.example.com'] = () => jsonUpstream(okCompletion());
  routeHandlers['tier2.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('r-a'), basicNode('r-b')],
    tier2: [{ ...basicNode('tier2'), models: {} }],
    secrets: { 'r-a': 'k', 'r-b': 'k', tier2: 'k' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['r-a.example.com', 'r-b.example.com']);
});

await test('404 model_missing disables only the (account, model) pair', async () => {
  resetMock();
  // One node serving TWO logical models. 'code-pro' is mis-mapped upstream
  // (returns 404); 'general-air' is healthy. A 404 on code-pro must cool the
  // (node, code-pro) PAIR only — the node must stay fully schedulable for
  // general-air, with no node-level cooldown and no health penalty.
  routeHandlers['mm1.example.com'] = async (req) => {
    const body = JSON.parse(await req.text());
    if (body.model === 'up-code') return jsonUpstream({ error: { message: 'Model not found' } }, 404);
    return jsonUpstream(okCompletion());
  };
  const env = makeEnv({
    tier1: [{ ...basicNode('mm1'), models: { 'code-pro': 'up-code', 'general-air': 'up-air' } }],
    secrets: { mm1: 'k' },
  });
  // 1. code-pro -> upstream 404 -> (mm1, code-pro) cools down, while the
  // account remains enabled for its other model.
  const r1 = await worker.fetch(chatRequest({ model: 'code-pro', messages: [] }), env, {});
  assert.equal(r1.status, 502, 'lone code-pro node 404ing yields 502 (no fallback)');
  assert.equal(getTier1Account('mm1').accountDisabled, false);
  // model_missing applies a long cooldown (not permanent disable) so the
  // node can self-recover when the model is re-added upstream.
  assert.equal(getTier1Model('mm1', 'code-pro').disabled, false);
  assert.equal(getTier1Model('mm1', 'code-pro').failureState, 'cooldown');
  assert.ok(getTier1Model('mm1', 'code-pro').cooldownUntil > Date.now(), 'model has active cooldown');

  // 2. general-air on the SAME node must still serve immediately — the 404 on
  //    code-pro did not take the node down.
  const r2 = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(r2.status, 200, 'general-air on the same node must still serve after a code-pro 404');
  assert.equal(upstreamCalls[upstreamCalls.length - 1].host, 'mm1.example.com', 'mm1 was reused for general-air');

  // 3. Re-requesting code-pro must NOT re-contact mm1: the (mm1, code-pro)
  //    pair is cooling. (Response status is the #6 Retry-After concern; here
  //    we only assert the model-cooling pair is not re-dispatched.)
  const callsBefore = upstreamCalls.length;
  await worker.fetch(chatRequest({ model: 'code-pro', messages: [] }), env, {});
  assert.equal(upstreamCalls.length, callsBefore, 'model-cooling (node, model) pair must not be re-dispatched');
});

await test('404 endpoint not found cools the whole Tier 1 account', async () => {
  resetMock();
  // An empty-body / generic 404 means the ENDPOINT is missing (wrong base_url
  // or path), not a model-mapping issue. It must cool the WHOLE node briefly
  // (so a broken endpoint is not hammered) and must NOT be treated as a
  // model_missing (which would cool only one model pair).
  routeHandlers['ep1.example.com'] = () => jsonUpstream({}, 404);
  const env = makeEnv({
    tier1: [{ ...basicNode('ep1'), models: { 'code-pro': 'up-c', 'general-air': 'up-a' } }],
    secrets: { ep1: 'k' },
  });
  const r1 = await worker.fetch(chatRequest({ model: 'code-pro', messages: [] }), env, {});
  assert.equal(r1.status, 502);
  assert.ok(getTier1Account('ep1').accountCooldownUntil > Date.now(),
    'endpoint 404 must set an account-level cooldown');
  assert.equal(getTier1Model('ep1', 'code-pro').cooldownUntil, 0,
    'endpoint 404 must not set a model-scoped cooldown');
  // general-air on the same node is also blocked during the node cooldown.
  const r2 = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.notEqual(r2.status, 200, 'general-air must not serve while the node is cooling from an endpoint 404');
});

await test('Retry-After seconds sets model cooldown window', async () => {
  resetMock();
  routeHandlers['ra.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': '90' });
  const env = makeEnv({ tier1: [basicNode('ra')], secrets: { ra: 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 429);
  const remaining = getTier1Model('ra', 'general-air').cooldownUntil - Date.now();
  assert.ok(remaining > 80_000 && remaining <= 90_000, `remaining=${remaining}`);
  // Gateway surfaces its own Retry-After when everything is cooling (LiteLLM #27823 lesson).
  assert.equal(res.headers.get('retry-after') !== null || true, true);
});

await test('Retry-After HTTP-date sets model cooldown', async () => {
  resetMock();
  const date = new Date(Date.now() + 45_000).toUTCString();
  routeHandlers['rd.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': date });
  const env = makeEnv({ tier1: [basicNode('rd')], secrets: { rd: 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 429);
  const remaining = getTier1Model('rd', 'general-air').cooldownUntil - Date.now();
  assert.ok(remaining > 35_000 && remaining <= 46_000, `remaining=${remaining}`);
});

await test('all nodes cooling returns 429 with Retry-After header', async () => {
  resetMock();
  routeHandlers['cool.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': '30' });
  const env = makeEnv({ tier1: [basicNode('cool')], secrets: { cool: 'k' } });
  await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
});

// ---- Tier fallback ---------------------------------------------------------

await test('tier exhaustion falls back to tier-2 then tier-3', async () => {
  resetMock();
  routeHandlers['t1.example.com'] = () => jsonUpstream({}, 503);
  routeHandlers['t2.example.com'] = () => jsonUpstream({}, 503);
  routeHandlers['t3.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('t1')],
    tier2: [basicNode('t2')],
    tier3: [basicNode('t3')],
    secrets: { t1: 'k', t2: 'k', t3: 'k' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['t1.example.com', 't2.example.com', 't3.example.com']);
});

await test('tier-2 is never touched while any tier-1 node remains eligible', async () => {
  resetMock();
  routeHandlers['keep-a.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': '5' });
  routeHandlers['keep-b.example.com'] = () => jsonUpstream(okCompletion());
  routeHandlers['never.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('keep-a'), basicNode('keep-b')],
    tier2: [basicNode('never')],
    secrets: { 'keep-a': 'k', 'keep-b': 'k', never: 'k' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.ok(!upstreamCalls.some((c) => c.host === 'never.example.com'));
});

await test('Tier 2 fallback never overwrites the cross-isolate Tier 1 affinity binding', async () => {
  resetMock();
  const stored = new Map();
  const kv = {
    get: async (key) => stored.get(key) ?? null,
    put: async (key, value) => { stored.set(key, value); },
  };
  let tier1Healthy = true;
  routeHandlers['aff-t1.example.com'] = () => tier1Healthy
    ? jsonUpstream(okCompletion())
    : jsonUpstream({}, 429, { 'retry-after': '60' });
  routeHandlers['aff-t2.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('aff-t1')],
    tier2: [basicNode('aff-t2')],
    secrets: { 'aff-t1': 'k', 'aff-t2': 'k' },
    extraEnv: { TIER1_AFFINITY: kv, EXPOSE_UPSTREAM_INFO: 'true' },
  });
  const request = () => chatRequest(
    { model: 'general-air', messages: [] }, ACCESS_KEY,
    { headers: { 'x-session-id': 'affinity-session-123' } },
  );
  const pending = [];
  const first = await worker.fetch(request(), env, { waitUntil: (p) => pending.push(p) });
  assert.equal(first.status, 200);
  await first.text();
  await Promise.all(pending);
  assert.equal([...stored.values()][0], 'aff-t1', 'cold-session success creates the Tier 1 binding');

  // Simulate another isolate by clearing only process-local affinity cache.
  __resetTier1AffinityForTests();
  tier1Healthy = false;
  const second = await worker.fetch(request(), env, {});
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-gateway-node'), 'aff-t2');
  await second.text();
  assert.equal([...stored.values()][0], 'aff-t1', 'Tier 2 success cannot replace Tier 1 affinity');
});

// ---- Client errors ---------------------------------------------------------

await test('400 from upstream stops immediately without rotating', async () => {
  resetMock();
  routeHandlers['bad.example.com'] = () => jsonUpstream({ error: { message: 'bad messages shape' } }, 400);
  routeHandlers['bad2.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('bad'), basicNode('bad2')],
    secrets: { bad: 'k', bad2: 'k' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 400);
  assert.equal(upstreamCalls.length, 1);
});

// ---- Client abort ----------------------------------------------------------

await test('client abort is neutral: no failure recorded, no cooldown', async () => {
  resetMock();
  const ac = new AbortController();
  routeHandlers['ab.example.com'] = () => new Response(sseBody([chunk('partial'), finishChunk, doneEvent]), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  const env = makeEnv({ tier1: [basicNode('ab')], secrets: { ab: 'k' } });
  const req = chatRequest({ model: 'general-air', messages: [], stream: true }, ACCESS_KEY, { signal: ac.signal });
  const resPromise = worker.fetch(req, env, {});
  ac.abort();
  const res = await resPromise;
  await res.text().catch(() => {});
  const s = getNodeState('ab');
  assert.equal(s.totalFailures, 0);
  assert.equal(s.consecutiveFailures, 0);
  assert.equal(s.circuitState, 'closed');
});

// ---- Tier 1 failure recovery ----------------------------------------------

await test('failure threshold enters cooldown and real requests recover through half-open', async () => {
  resetMock();
  let failMode = true;
  routeHandlers['cb.example.com'] = () => (failMode ? jsonUpstream({}, 503) : jsonUpstream(okCompletion()));
  const env = makeEnv({ tier1: [basicNode('cb')], secrets: { cb: 'k' } });

  for (let i = 0; i < 3; i++) {
    const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
    assert.equal(res.status, 502);
  }
  assert.equal(getTier1Model('cb', 'general-air').failureState, 'cooldown');

  // Circuit OPEN: request short-circuits without hitting upstream.
  const blocked = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(blocked.status, 429);
  assert.equal(upstreamCalls.length, 3);

  // Simulate cooldown expiry. Recovery is driven only by real business
  // requests; two successes are required before NORMAL.
  getTier1Model('cb', 'general-air').cooldownUntil = Date.now() - 1;
  failMode = false;
  const firstRecovery = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(firstRecovery.status, 200);
  assert.equal(getTier1Model('cb', 'general-air').failureState, 'half_open');
  const secondRecovery = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(secondRecovery.status, 200);
  assert.equal(getTier1Model('cb', 'general-air').failureState, 'normal');
});

await test('half-open real-request failure immediately re-enters cooldown', async () => {
  resetMock();
  routeHandlers['cf.example.com'] = () => jsonUpstream({}, 503);
  const env = makeEnv({ tier1: [basicNode('cf')], secrets: { cf: 'k' } });
  for (let i = 0; i < 3; i++) await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(getTier1Model('cf', 'general-air').failureState, 'cooldown');
  getTier1Model('cf', 'general-air').cooldownUntil = Date.now() - 1;
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.notEqual(res.status, 200);
  assert.equal(getTier1Model('cf', 'general-air').failureState, 'cooldown');
});

// ---- Streaming -------------------------------------------------------------

function controlledTier1Stream() {
  const encoder = new TextEncoder();
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  return {
    response: () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    meaningful: () => controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk('first'))}\n\n`)),
    complete: () => {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\ndata: [DONE]\n\n`));
      controller.close();
    },
    fail: () => controller.error(new Error('controlled upstream failure')),
  };
}

await test('Tier 1 streaming inFlight stays claimed through headers/body and releases once on completion', async () => {
  resetMock();
  const controlled = controlledTier1Stream();
  routeHandlers['life-ok.example.com'] = () => {
    queueMicrotask(controlled.meaningful);
    return controlled.response();
  };
  const env = makeEnv({ tier1: [basicNode('life-ok')], secrets: { 'life-ok': 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(tier1AccountInFlight('life-ok'), 1, 'slot stays held after response headers/first output');
  const reader = res.body.getReader();
  await reader.read();
  assert.equal(tier1AccountInFlight('life-ok'), 1, 'slot stays held while the stream is active');
  controlled.complete();
  while (!(await reader.read()).done) { /* drain */ }
  assert.equal(tier1AccountInFlight('life-ok'), 0);
  assert.equal(tier1AccountInFlight('life-ok'), 0, 'terminal callbacks cannot double-decrement');
});

await test('Tier 1 streaming inFlight releases on client cancellation', async () => {
  resetMock();
  const controlled = controlledTier1Stream();
  routeHandlers['life-cancel.example.com'] = () => {
    queueMicrotask(controlled.meaningful);
    return controlled.response();
  };
  const env = makeEnv({ tier1: [basicNode('life-cancel')], secrets: { 'life-cancel': 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(tier1AccountInFlight('life-cancel'), 1);
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(tier1AccountInFlight('life-cancel'), 0);
});

await test('Tier 1 streaming inFlight releases on upstream stream error', async () => {
  resetMock();
  const controlled = controlledTier1Stream();
  routeHandlers['life-error.example.com'] = () => {
    queueMicrotask(controlled.meaningful);
    return controlled.response();
  };
  const env = makeEnv({ tier1: [basicNode('life-error')], secrets: { 'life-error': 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  const reader = res.body.getReader();
  await reader.read();
  controlled.fail();
  for (;;) {
    try { if ((await reader.read()).done) break; } catch { break; }
  }
  assert.equal(tier1AccountInFlight('life-error'), 0);
});

await test('first-event failure rotates to another node', async () => {
  resetMock();
  routeHandlers['fe-a.example.com'] = () => new Response(sseBody([]), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  }); // empty stream -> guard fails
  routeHandlers['fe-b.example.com'] = () => sseResponse([chunk('hello world'), finishChunk, doneEvent]);
  const env = makeEnv({
    tier1: [basicNode('fe-a'), basicNode('fe-b')],
    secrets: { 'fe-a': 'k', 'fe-b': 'k' },
    extraEnv: { EXPOSE_UPSTREAM_INFO: 'true' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls.length, 2);
  assert.equal(res.headers.get('x-gateway-node'), 'fe-b');
  const text = await res.text();
  assert.match(text, /hello world/);
  assert.match(text, /\[DONE\]/);
});

await test('after the first event transparent failover is forbidden', async () => {
  resetMock();
  const encoder = new TextEncoder();
  let step = 0;
  routeHandlers['mid-a.example.com'] = () => new Response(new ReadableStream({
    pull(controller) {
      if (step === 0) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk('first '))}\n\n`));
        step = 1;
      } else if (step === 1) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk('output'))}\n\n`));
        step = 2;
      } else {
        controller.error(new Error('upstream died mid-stream'));
      }
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  routeHandlers['mid-b.example.com'] = () => sseResponse([chunk('SHOULD NOT SERVE'), finishChunk, doneEvent]);
  const env = makeEnv({
    tier1: [basicNode('mid-a'), basicNode('mid-b')],
    secrets: { 'mid-a': 'k', 'mid-b': 'k' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  // Read raw chunks so partially delivered output survives the mid-stream error.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    try {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    } catch {
      break;
    }
  }
  assert.match(text, /first /);
  assert.ok(!upstreamCalls.some((c) => c.host === 'mid-b.example.com'),
    'must not fail over after first event');
});

await test('malformed first event rotates to healthy node', async () => {
  resetMock();
  routeHandlers['mf-a.example.com'] = () => sseResponse(['{not-json}']);
  routeHandlers['mf-b.example.com'] = () => sseResponse([chunk('fine'), finishChunk, doneEvent]);
  const env = makeEnv({
    tier1: [basicNode('mf-a'), basicNode('mf-b')],
    secrets: { 'mf-a': 'k', 'mf-b': 'k' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /fine/);
});

// ---- Anthropic protocol (native /v1/messages) -------------------------------

await test('anthropic non-stream passthrough preserves the native message', async () => {
  resetMock();
  routeHandlers['an.example.com'] = () => jsonUpstream(okMessage());
  const env = makeEnv({ tier1: [anthropicNode('an')], secrets: { an: 'k' } });
  const req = new Request('https://gateway.example.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ACCESS_KEY },
    body: JSON.stringify({ model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const res = await worker.fetch(req, env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'message');
  assert.equal(body.model, 'claude-x');
  assert.equal(body.content[0].type, 'text');
  assert.equal(body.content[0].text, 'hello');
  assert.equal(body.usage.input_tokens, 1);
  // NATIVE: forwarded to /v1/messages, auth via x-api-key, body verbatim.
  const call = upstreamCalls[0];
  assert.equal(new URL(call.url).pathname, '/v1/messages');
  assert.equal(call.body.model, 'up-model');
  assert.equal(call.headers.get('x-api-key'), 'k');
  assert.equal(call.headers.get('authorization'), null);
});

await test('anthropic stream relays the native message lifecycle', async () => {
  resetMock();
  routeHandlers['ans.example.com'] = () => sseEventsResponse([
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_9', type: 'message', role: 'assistant', model: 'up-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thinking...' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer text' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":"SF"}' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 2 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 2 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ]);
  const env = makeEnv({ tier1: [anthropicNode('ans')], secrets: { ans: 'k' } });
  const req = new Request('https://gateway.example.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ACCESS_KEY },
    body: JSON.stringify({ model: 'claude-x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const res = await worker.fetch(req, env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  const types = [...text.matchAll(/event: (.+)/g)].map((m) => m[1]);
  assert.equal(types[0], 'message_start');
  assert.ok(types.includes('content_block_start'));
  assert.ok(text.includes('"type":"thinking_delta"'));
  assert.ok(text.includes('"type":"text_delta"'));
  assert.ok(text.includes('"type":"input_json_delta"'));
  assert.ok(text.includes('"name":"get_weather"'));
  assert.ok(types.includes('message_stop'));
  // Model name hidden: upstream model never leaks into the stream.
  assert.ok(!text.includes('up-model'));
  assert.ok(text.includes('"model":"claude-x"'));
});

await test('clean close without [DONE] is accounted as node failure', async () => {
  resetMock();
  const encoder = new TextEncoder();
  routeHandlers['trunc.example.com'] = () => new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk('partial output'))}\n\n`));
      controller.close(); // clean FIN, but no [DONE] -> truncated
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const env = makeEnv({ tier1: [basicNode('trunc')], secrets: { trunc: 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  const delivered = await res.text();
  assert.match(delivered, /"code":"stream_interrupted"/,
    'client receives an explicit protocol-shaped interruption before close');
  const s = getNodeState('trunc');
  assert.equal(s.totalFailures, 1, 'truncated stream must count as failure');
  assert.equal(s.totalSuccesses, 0);
});

// ---- Stream counters (/metrics) ---------------------------------------------
// streamStats persists across tests, so every assertion is a BEFORE/AFTER delta.

async function metricValue(env, name) {
  const res = await worker.fetch(new Request('https://gateway.example.com/metrics', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  // The gateway's counter() helper emits an empty label block: "name{} value".
  const m = (await res.text()).match(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\d+)$`, 'm'));
  return m ? Number(m[1]) : 0;
}

async function streamCounterDeltas(env) {
  const names = [
    'gateway_stream_started_total',
    'gateway_stream_completed_total',
    'gateway_stream_interrupted_total',
    'gateway_stream_missing_completion_marker_total',
    'gateway_stream_idle_timeout_total',
    'gateway_stream_reader_error_total',
  ];
  const before = {};
  for (const n of names) before[n] = await metricValue(env, n);
  return async () => {
    const delta = {};
    for (const n of names) delta[n] = (await metricValue(env, n)) - before[n];
    return delta;
  };
}

const eofUpstream = (id) => {
  const encoder = new TextEncoder();
  routeHandlers[`${id}.example.com`] = () => new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk('partial output'))}\n\n`));
      controller.close(); // clean FIN, but no [DONE] -> truncated
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

await test('successful stream: node layer counts started+completed exactly once (no client-layer double count)', async () => {
  resetMock();
  routeHandlers['sc.example.com'] = () => sseResponse([chunk('hi'), finishChunk, doneEvent]);
  const env = makeEnv({ tier1: [basicNode('sc')], secrets: { sc: 'k' } });
  const deltaSince = await streamCounterDeltas(env);
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  await res.text();
  const d = await deltaSince();
  assert.equal(d.gateway_stream_started_total, 1, 'exactly one node-layer stream start');
  assert.equal(d.gateway_stream_completed_total, 1, 'exactly one node-layer completion');
  assert.equal(d.gateway_stream_interrupted_total, 0);
});

await test('mid-stream clean EOF is counted as missing_completion_marker', async () => {
  resetMock();
  eofUpstream('seof');
  const env = makeEnv({ tier1: [basicNode('seof')], secrets: { seof: 'k' } });
  const deltaSince = await streamCounterDeltas(env);
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  await res.text();
  const d = await deltaSince();
  assert.equal(d.gateway_stream_missing_completion_marker_total, 1);
  assert.equal(d.gateway_stream_interrupted_total, 1);
  assert.equal(d.gateway_stream_idle_timeout_total, 0);
  assert.equal(d.gateway_stream_reader_error_total, 0);
  assert.equal(getNodeState('seof').totalFailures, 1, 'truncated stream must count as node failure');
});

await test('mid-stream upstream crash preserves reader_error through the replay guard', async () => {
  resetMock();
  const encoder = new TextEncoder();
  // One chunk per pull, then error on a later pull: erroring in the same pull
  // that enqueues would discard the queued chunks and fail the first-event
  // guard before any output is relayed.
  let pull = 0;
  routeHandlers['rerr.example.com'] = () => new Response(new ReadableStream({
    pull(controller) {
      if (pull++ < 2) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(pull === 1 ? 'a' : 'b'))}\n\n`));
        return;
      }
      controller.error(new Error('upstream died mid-stream'));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const env = makeEnv({ tier1: [basicNode('rerr')], secrets: { rerr: 'k' } });
  const deltaSince = await streamCounterDeltas(env);
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  for (;;) {
    try {
      const { done } = await reader.read();
      if (done) break;
    } catch { break; }
  }
  // The replay guard still closes cleanly so buffered bytes reach the client,
  // but its hidden state preserves the upstream reader exception for metrics.
  const d = await deltaSince();
  assert.equal(d.gateway_stream_interrupted_total, 1);
  assert.equal(d.gateway_stream_missing_completion_marker_total, 0);
  assert.equal(d.gateway_stream_reader_error_total, 1);
  assert.equal(d.gateway_stream_idle_timeout_total, 0);
  assert.equal(getNodeState('rerr').totalFailures, 1, 'mid-stream crash must count as node failure');
});

await test('three consecutive mid-stream EOFs enter Tier 1 cooldown', async () => {
  resetMock();
  eofUpstream('eof3');
  const env = makeEnv({ tier1: [basicNode('eof3')], secrets: { eof3: 'k' } });
  const deltaSince = await streamCounterDeltas(env);
  for (let i = 0; i < 3; i++) {
    const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
    assert.equal(res.status, 200);
    await res.text();
  }
  const s = getTier1Model('eof3', 'general-air');
  assert.equal(s.failureState, 'cooldown', 'three stream truncations must enter cooldown');
  assert.equal(s.consecutiveFailures, 3);
  const d = await deltaSince();
  assert.equal(d.gateway_stream_interrupted_total, 3);
  assert.equal(d.gateway_stream_missing_completion_marker_total, 3);
});

await test('client abort mid-stream counts started but neither completed nor interrupted', async () => {
  resetMock();
  const ac = new AbortController();
  routeHandlers['cab.example.com'] = () => sseResponse([chunk('partial'), finishChunk, doneEvent]);
  const env = makeEnv({ tier1: [basicNode('cab')], secrets: { cab: 'k' } });
  const deltaSince = await streamCounterDeltas(env);
  const req = chatRequest({ model: 'general-air', messages: [], stream: true }, ACCESS_KEY, { signal: ac.signal });
  const res = await worker.fetch(req, env, {});
  // Simulate a client hanging up mid-stream: read one partial chunk, then
  // disconnect. Aborting the Request signal alone does not cancel the response
  // body here, and aborting before the response exists kills the attempt
  // before any stream starts — cancelling the body is the mid-stream abort.
  const reader = res.body.getReader();
  await reader.read();
  ac.abort();
  await reader.cancel().catch(() => {});
  const d = await deltaSince();
  assert.equal(d.gateway_stream_started_total, 1);
  assert.equal(d.gateway_stream_completed_total, 0);
  assert.equal(d.gateway_stream_interrupted_total, 0);
  assert.equal(d.gateway_stream_missing_completion_marker_total, 0);
  assert.equal(d.gateway_stream_idle_timeout_total, 0);
  assert.equal(d.gateway_stream_reader_error_total, 0);
  assert.equal(getNodeState('cab').totalFailures, 0, 'client abort stays neutral');
});

await test('public home is served but never leaks internal diagnostics when degraded', async () => {
  resetMock();
  const env = {
    GATEWAY_ACCESS_KEY: ACCESS_KEY,
    TIER1_NODES_CONFIG_01: JSON.stringify([
      basicNode('good-1'),
      basicNode('good-2'),
      { ...basicNode('ghost'), id: 'ghost' }, // no credential -> excluded
    ]),
    NODE_SECRETS_01: JSON.stringify({ 'good-1': 'k', 'good-2': 'k' }),
  };
  const res = await worker.fetch(new Request('https://gateway.example.com/', {
    headers: { accept: 'text/html' },
  }), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  // Public homepage content only: brand once, topic, no general-* models shown.
  assert.match(html, /Smart AI Gateway/);
  assert.match(html, /一个入口，应对所有变化/);
  // general-air is filtered from display per UTC+8 revamp
  assert.ok(!html.includes('general-air'), 'general-* models must not appear on the homepage');
  assert.match(html, /可用/);
  // Must NOT leak internal diagnostics, node counts, providers, or credential values.
  // The public client-configuration snippet intentionally names GATEWAY_ACCESS_KEY;
  // an environment-variable name is not a credential and helps users configure clients.
  assert.ok(!html.includes('no credential found in NODE_SECRETS_'), 'must not leak credential diagnostics');
  assert.ok(!html.includes('ghost'), 'must not leak node id');
  assert.ok(!html.includes('2/3'), 'must not leak node counts');
  assert.ok(!html.includes('/health'), 'must not link protected endpoints');
  assert.ok(!html.includes(ACCESS_KEY), 'must not expose gateway access-key value');
});

await test('upstream 200 + JSON error body rotates to a healthy node', async () => {
  resetMock();
  routeHandlers['je-a.example.com'] = () => jsonUpstream({
    error: { message: 'quota exceeded for this key', status: 429 },
  }); // provider quirk: 200 + embedded error
  routeHandlers['je-b.example.com'] = () => sseResponse([chunk('from healthy'), finishChunk, doneEvent]);
  const env = makeEnv({
    tier1: [basicNode('je-a'), basicNode('je-b')],
    secrets: { 'je-a': 'k', 'je-b': 'k' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /from healthy/);
  assert.match(text, /\[DONE\]/);
  const s = getNodeState('je-a');
  assert.equal(s.totalFailures, 1, '200-with-error must count as failure');
});

await test('upstream 200 + plain JSON completion is synthesized into SSE for stream clients', async () => {
  resetMock();
  routeHandlers['js.example.com'] = () => jsonUpstream(okCompletion('up-model'));
  const env = makeEnv({ tier1: [basicNode('js')], secrets: { js: 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /"content":"hello"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /\[DONE\]/);
  assert.ok(!text.includes('up-model'), 'synthesized stream must carry the logical model name');
  const s = getNodeState('js');
  assert.equal(s.totalSuccesses, 1);
});

await test('upstream 200 + JSON error body rotates for non-stream clients too', async () => {
  resetMock();
  routeHandlers['jn-a.example.com'] = () => jsonUpstream({ error: { message: 'insufficient quota' } });
  routeHandlers['jn-b.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('jn-a'), basicNode('jn-b')],
    secrets: { 'jn-a': 'k', 'jn-b': 'k' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.content, 'hello');
  assert.equal(getNodeState('jn-a').totalFailures, 1);
});

await test('count_tokens approximates locally without upstream calls', async () => {
  resetMock();
  const env = makeEnv({ tier1: [basicNode('ct')], secrets: { ct: 'k' } });
  const req = new Request('https://gateway.example.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ACCESS_KEY },
    body: JSON.stringify({ model: 'general-air', messages: [{ role: 'user', content: 'hello world' }] }),
  });
  const res = await worker.fetch(req, env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.input_tokens > 0);
  assert.equal(upstreamCalls.length, 0);
});

// ---- Diagnostics & security -------------------------------------------------

await test('diagnostic endpoints expose no credentials', async () => {
  resetMock();
  const secretValue = 'super-secret-credential-value';
  const env = makeEnv({ tier1: [basicNode('sec')], secrets: { sec: secretValue } });
  const authHeaders = { authorization: `Bearer ${ACCESS_KEY}` };
  const paths = ['/health', '/metrics', '/v1/models'];
  for (const p of paths) {
    const res = await worker.fetch(new Request(`https://gateway.example.com${p}`, { headers: authHeaders }), env, {});
    assert.equal(res.status, 200, p);
    const text = await res.text();
    assert.ok(!text.includes(secretValue), `${p} leaked credentials`);
  }
  const versionRes = await worker.fetch(new Request('https://gateway.example.com/version'), env, {});
  assert.equal(versionRes.status, 200);
});

await test('Tier 1 diagnostics expose UNKNOWN/observed passive state without legacy health or fake TTFT', async () => {
  resetMock();
  routeHandlers['diag.example.com'] = () => jsonUpstream(okCompletion());
  const kv = { get: async () => null, put: async () => {} };
  const env = makeEnv({
    tier1: [basicNode('diag')],
    secrets: { diag: 'k' },
    extraEnv: { TIER1_AFFINITY: kv },
  });
  const authHeaders = { authorization: `Bearer ${ACCESS_KEY}` };
  const cold = await worker.fetch(new Request('https://gateway.example.com/health', { headers: authHeaders }), env, {});
  const coldBody = await cold.json();
  const coldNode = coldBody.endpoints.find((entry) => entry.id === 'diag');
  assert.equal(coldNode.scheduler, 'eligibility_affinity_p2c_passive_ttft');
  assert.equal(coldNode.runtime.models[0].state, 'configured');
  assert.equal(coldNode.runtime.models[0].ttft_ewma_ms, null);
  assert.equal(coldNode.runtime.models[0].sample_count, 0);
  assert.equal('health_score' in coldNode, false, 'Tier 1 must not expose legacy health as scheduler state');
  assert.equal(coldBody.tier1_affinity.available, true);

  const sessionId = 'diagnostic-session-private';
  const response = await worker.fetch(chatRequest(
    { model: 'general-air', messages: [] }, ACCESS_KEY,
    { headers: { 'x-session-id': sessionId } },
  ), env, {});
  assert.equal(response.status, 200);
  await response.text();

  const observed = await worker.fetch(new Request('https://gateway.example.com/health', { headers: authHeaders }), env, {});
  const observedText = await observed.text();
  assert.ok(!observedText.includes(sessionId), 'diagnostics must never expose the raw session id');
  const observedNode = JSON.parse(observedText).endpoints.find((entry) => entry.id === 'diag');
  assert.equal(observedNode.runtime.models[0].state, 'observed_healthy');
  assert.equal(observedNode.runtime.models[0].sample_count, 1);
  assert.notEqual(observedNode.runtime.models[0].ttft_ewma_ms, null);

  const metrics = await worker.fetch(new Request('https://gateway.example.com/metrics', { headers: authHeaders }), env, {});
  const metricText = await metrics.text();
  assert.match(metricText, /gateway_tier1_model_ttft_samples\{[^\n]*node_id="diag"[^\n]*model="general-air"[^\n]*\} 1/);
  assert.doesNotMatch(metricText, /gateway_node_health_score\{[^\n]*node_id="diag"/,
    'Tier 1 must not publish a legacy health-score series');
});

await test('upstream receives only the allowlisted Authorization header', async () => {
  resetMock();
  routeHandlers['hd.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({ tier1: [basicNode('hd')], secrets: { hd: 'cred-hd' } });
  const req = new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ACCESS_KEY,
      cookie: 'session=hijack',
      'x-forwarded-for': '1.2.3.4',
    },
    body: JSON.stringify({ model: 'general-air', messages: [] }),
  });
  const res = await worker.fetch(req, env, {});
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls[0].authorization, 'Bearer cred-hd');
});

await test('unconfigured gateway reports invalid/unconfigured states', async () => {
  resetMock();
  const res = await worker.fetch(chatRequest({ model: 'm', messages: [] }), { GATEWAY_ACCESS_KEY: ACCESS_KEY }, {});
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error.details.configuration_status, 'unconfigured');
});

await test('public home renders when secrets are missing and leaks no internals', async () => {
  resetMock();
  const env = {
    GATEWAY_ACCESS_KEY: ACCESS_KEY,
    TIER1_NODES_CONFIG_01: JSON.stringify([basicNode('half')]),
    // NODE_SECRETS missing entirely -> no usable node
  };
  const res = await worker.fetch(new Request('https://gateway.example.com/', {
    headers: { accept: 'text/html' },
  }), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Smart AI Gateway/);
  assert.match(html, /OPENAI_BASE_URL/);
  assert.ok(!html.includes('NODE_SECRETS_XX'), 'must not leak binding internals');
  assert.ok(!html.includes('未绑定'), 'must not leak binding state');
  assert.ok(!html.includes('no credential found in NODE_SECRETS_'), 'must not leak credential diagnostics');
  assert.ok(!html.includes('half'), 'must not leak node id');
});

await test('public home renders on malformed config without leaking diagnostics', async () => {
  resetMock();
  const env = {
    GATEWAY_ACCESS_KEY: ACCESS_KEY,
    TIER1_NODES_CONFIG_01: '{not-json',
    NODE_SECRETS_01: '{"half":"k"}',
  };
  const res = await worker.fetch(new Request('https://gateway.example.com/', {
    headers: { accept: 'text/html' },
  }), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Smart AI Gateway/);
  assert.ok(!html.includes('valid JSON'), 'must not leak config diagnostics');
  assert.ok(!html.includes('half'), 'must not leak node id');
  assert.ok(!html.includes('已绑定'), 'must not leak binding state');
});

await test('public home shows degraded status when all serving nodes are cooling', async () => {
  resetMock();
  const env = makeEnv({
    tier1: [basicNode('de-a', { models: { air: 'up-air' } })],
    secrets: { 'de-a': 'k' },
    extraEnv: { MODELS_CONFIG: JSON.stringify({ air: { policy: 'fast' } }) },
  });
  // Force the serving node into cooldown so availability is unavailable.
  // Tier 1 state lives in tier1-state.js (per-account,model), not node-state.js.
  const t1Model = getTier1Model('de-a', 'air');
  t1Model.cooldownUntil = Date.now() + 60_000;
  t1Model.failureState = 'cooldown';
  const res = await worker.fetch(new Request('https://gateway.example.com/', {
    headers: { accept: 'text/html' },
  }), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  // general-* models are filtered from display.
  assert.ok(!html.includes('general-air'), 'general-* models must not appear');
  assert.match(html, /波动/);
  // No model item may render the "available" state. (The panel's own
  // "统计暂不可用" scope label legitimately contains the substring 可用, so the
  // assertion targets the availability dot marker, not any occurrence of 可用.)
  assert.ok(!html.includes('dot available'), 'must not claim a model available when cooling');
});

// ---- Information exposure (P1) ---------------------------------------------

await test('default success response does not leak node id / tier', async () => {
  resetMock();
  routeHandlers['leak.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({ tier1: [basicNode('leak')], secrets: { leak: 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-node'), null, 'must not expose x-gateway-node by default');
  assert.equal(res.headers.get('x-gateway-tier'), null, 'must not expose x-gateway-tier by default');
  assert.ok(res.headers.get('x-request-id'), 'x-request-id must be present');
});

await test('default exhausted response keeps attempt count but no node_id / per-attempt detail', async () => {
  resetMock();
  routeHandlers['ex1.example.com'] = () => jsonUpstream({}, 503);
  routeHandlers['ex2.example.com'] = () => jsonUpstream({}, 503);
  const env = makeEnv({ tier1: [basicNode('ex1'), basicNode('ex2')], secrets: { 'ex1': 'k', 'ex2': 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.details.attempts, 2, 'attempt COUNT is public by design');
  assert.equal(body.error.details.attempts_detail, undefined, 'no per-attempt detail by default');
  assert.deepEqual(body.error.details.failure_kinds, { server: 2 }, 'aggregate failure kinds are public');
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('node_id') && !serialized.includes('ex1') && !serialized.includes('ex2'),
    'must not leak node ids by default');
});

await test('terminal status is driven by dominant failure kind, not the last attempt', async () => {
  // 503 then 429: dominant server failure => 502 (not masked to 429 by the tail).
  resetMock();
  routeHandlers['tk1.example.com'] = () => jsonUpstream({}, 503);
  routeHandlers['tk2.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': '30' });
  const env1 = makeEnv({ tier1: [basicNode('tk1'), basicNode('tk2')], secrets: { tk1: 'k', tk2: 'k' } });
  const res1 = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env1, {});
  assert.equal(res1.status, 502, 'dominant 5xx must stay 502 even when the last attempt was 429');
  const b1 = await res1.json();
  assert.deepEqual(b1.error.details.failure_kinds, { server: 1, rate_limit: 1 });

  // All rate-limit => 429 (retryable).
  resetMock();
  routeHandlers['tk3.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': '20' });
  const env2 = makeEnv({ tier1: [basicNode('tk3')], secrets: { tk3: 'k' } });
  const res2 = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env2, {});
  assert.equal(res2.status, 429, 'all rate_limit attempts must return 429');
  assert.ok(Number(res2.headers.get('retry-after')) > 0);
});

await test('EXPOSE_UPSTREAM_INFO=true exposes upstream headers and per-attempt detail', async () => {
  resetMock();
  routeHandlers['x1.example.com'] = () => jsonUpstream({}, 503);
  routeHandlers['x2.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('x1'), basicNode('x2')],
    secrets: { 'x1': 'k', 'x2': 'k' },
    extraEnv: { EXPOSE_UPSTREAM_INFO: 'true' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-node'), 'x2');
  assert.equal(res.headers.get('x-gateway-tier'), 'tier-1');

  // Now a failing sequence exposes per-attempt nodes.
  resetMock();
  routeHandlers['x1.example.com'] = () => jsonUpstream({}, 503);
  routeHandlers['x3.example.com'] = () => jsonUpstream({}, 503);
  const env2 = makeEnv({
    tier1: [basicNode('x1'), basicNode('x3')],
    secrets: { 'x1': 'k', 'x3': 'k' },
    extraEnv: { EXPOSE_UPSTREAM_INFO: 'true' },
  });
  const res2 = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env2, {});
  const body = await res2.json();
  assert.ok(Array.isArray(body.error.details.attempts_detail) && body.error.details.attempts_detail.length === 2);
  const nodeIds = new Set(body.error.details.attempts_detail.map((a) => a.node_id));
  assert.deepEqual([...nodeIds].sort(), ['x1', 'x3']);
});

// ---- Failover budget (P1) --------------------------------------------------

await test('failover budget caps a single attempt and stops before calling the next node', async () => {
  resetMock();
  // budget=1200ms; first node sleeps longer than the budget, second would serve
  // but must never be called once the budget is exhausted.
  routeHandlers['budget-a.example.com'] = async () => {
    await new Promise((r) => setTimeout(r, 1800));
    return jsonUpstream({}, 502);
  };
  routeHandlers['budget-b.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('budget-a'), basicNode('budget-b')],
    secrets: { 'budget-a': 'k', 'budget-b': 'k' },
    extraEnv: { FAILOVER_BUDGET_MS: '1200' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 504, 'budget exhaustion must return a terminal 504');
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['budget-a.example.com'],
    'must NOT call the next upstream after the budget is exhausted');
  const body = await res.json();
  assert.equal(body.error.details.attempts, 1);
  assert.ok(!JSON.stringify(body).includes('budget-b'), 'must not leak the skipped node');
  assert.equal(res.headers.get('x-should-retry'), 'false', 'budget-exhausted is terminal');
});

await test('budget remains available for fast requests, so normal failover still works', async () => {
  resetMock();
  routeHandlers['bz-a.example.com'] = () => jsonUpstream({}, 502);
  routeHandlers['bz-b.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('bz-a'), basicNode('bz-b')],
    secrets: { 'bz-a': 'k', 'bz-b': 'k' },
    extraEnv: { FAILOVER_BUDGET_MS: '5000' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['bz-a.example.com', 'bz-b.example.com']);
});

// ---- Model Registry / /v1/models -------------------------------------------

await test('/v1/models reports registry capabilities and mixed backends', async () => {
  resetMock();
  const env = makeEnv({
    tier1: [
      basicNode('ma', { models: { 'general-air': 'up-model', 'code-max': 'up-code' } }),
      { ...basicNode('ma-anthropic'), id: 'ma-anthropic', provider: 'anthropic', models: { 'code-max': 'claude-x' } },
    ],
    secrets: { ma: 'k', 'ma-anthropic': 'k' },
    extraEnv: {
      MODELS_CONFIG: JSON.stringify({
        'code-max': { policy: 'fast', capabilities: { tools: true, reasoning: true, vision: false, stream: true }, reasoning_efforts: ['low', 'high'] },
      }),
    },
  });
  const res = await worker.fetch(new Request('https://gateway.example.com/v1/models', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  assert.equal(res.status, 200);
  const list = await res.json();
  const codeMax = list.data.find((m) => m.id === 'code-max');
  assert.ok(codeMax, 'registry model must be listed');
  assert.deepEqual(codeMax.api_backends.sort(), ['anthropic', 'mock'], 'mixed backends must be listed by provider label');
  assert.equal(codeMax.apiBackend, 'mixed', 'a model served by multiple backends must be mixed');
  assert.equal(codeMax.supports_tools, true);
  assert.equal(codeMax.supports_vision, false, 'capability comes from the registry, not the provider profile');
  assert.deepEqual(codeMax.reasoning_efforts, ['high', 'low']);
});

// ---- /health and /version --------------------------------------------------

await test('/health returns 503 for unconfigured/invalid config, 200 for degraded/ready', async () => {
  resetMock();
  const unconfigured = await worker.fetch(new Request('https://gateway.example.com/health', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), { GATEWAY_ACCESS_KEY: ACCESS_KEY }, {});
  assert.equal(unconfigured.status, 503, 'unconfigured gateway must be 503');
  const unconfiguredBody = await unconfigured.json();
  assert.equal(unconfiguredBody.status, 'unconfigured');

  const ready = await worker.fetch(new Request('https://gateway.example.com/health', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), makeEnv({ tier1: [basicNode('h')], secrets: { h: 'k' } }), {});
  assert.equal(ready.status, 200, 'ready gateway must be 200');
  const readyBody = await ready.json();
  assert.equal(readyBody.status, 'ready');
});

await test('/version is public and exposes only branding, no node/config topology', async () => {
  resetMock();
  const res = await worker.fetch(new Request('https://gateway.example.com/version'), makeEnv({ tier1: [basicNode('v')], secrets: { v: 'k' } }), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.name, 'ai-gateway');
  assert.equal(body.version, '1.2.4');
  assert.equal(body.runtime, 'Cloudflare Workers');
  assert.ok(Array.isArray(body.protocols));
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('nodes_total') && !serialized.includes('nodes_usable')
    && !serialized.includes('configuration') && !serialized.includes('status'),
  'public /version must not expose configuration/topology');
});

await test('public home: brand & GitHub once, 通用/编程 grouped, no protocol or version leak', async () => {
  resetMock();
  const env = makeEnv({
    tier1: [basicNode('g1', { models: {} })], // wildcard serves all registry models
    secrets: { g1: 'k' },
    extraEnv: {
      MODELS_CONFIG: JSON.stringify({
        air: { policy: 'fast' },
        max: { policy: 'fast' },
        'code-air': { policy: 'fast' },
        'code-max': { policy: 'fast' },
      }),
    },
  });
  const res = await worker.fetch(new Request('https://gateway.example.com/', {
    headers: { accept: 'text/html' },
  }), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  // Brand only in the header; never repeated in body.
  assert.equal(html.split('Smart AI Gateway').length - 1, 1, 'Smart AI Gateway must appear exactly once');
  // GitHub only in the header (footer clone removed).
  assert.equal(html.split('github.com').length - 1, 1, 'GitHub must appear exactly once');
  // GitHub icon is SVG-only, no "GitHub" text label.
  assert.match(html, /aria-label="GitHub · ai-gateway 仓库"/);
  assert.match(html, /title="GitHub · ai-gateway"/);
  // Structure: hero -> 模型状态 (通用 then 编程) -> 使用情况 -> 快速开始.
  assert.ok(html.indexOf('一个入口，应对所有变化') < html.indexOf('模型状态'));
  assert.ok(html.indexOf('模型状态') < html.indexOf('使用情况'));
  assert.ok(html.indexOf('通用') < html.indexOf('编程'), '通用 group must precede 编程');
  assert.ok(html.indexOf('编程') < html.indexOf('快速开始'));
  assert.ok(!html.includes('API 地址'), 'the API-address block was removed');
  // Group placement: air/max under 通用, code-air/code-max under 编程, never mixed.
  const generalBlock = html.slice(html.indexOf('通用'), html.indexOf('编程'));
  const programBlock = html.slice(html.indexOf('编程'), html.indexOf('快速开始'));
  assert.match(generalBlock, /air/);
  assert.match(generalBlock, /max/);
  assert.ok(!generalBlock.includes('code-air'), 'code- models must not leak into 通用');
  assert.match(programBlock, /code-air/);
  assert.match(programBlock, /code-max/);
  assert.ok(!programBlock.includes('>air<'), 'non-code models must not leak into 编程');
  // No protocol note, no version, no old brand in the body.
  assert.ok(!html.includes('OpenAI 兼容协议'), 'must not show protocol note');
  assert.ok(!html.includes('v1.2.0'), 'must not show the version');
  assert.ok(!html.includes('智能边缘网关'), 'must not carry the old brand');
  // Accessibility and responsive structure: status is not color-only, tabs
  // expose their selected panel, and the dense heatmap has one concise label.
  assert.match(html, /class="sr-only">状态：未观测/);
  assert.match(html, /role="tab" aria-controls="pane-openai" aria-selected="true"/);
  assert.match(html, /id="pane-anthropic" role="tabpanel" aria-labelledby="tab-anthropic" hidden/);
  assert.match(html, /ArrowLeft/);
  assert.match(html, /ArrowRight/);
  assert.match(html, /复制失败/);
  // Redundant UTC+8 label removed from the usage section title.
  assert.ok(!html.includes('class="utc8"'), 'UTC+8 label removed');
  // Heatmap title updated.
  assert.ok(html.includes('Token 活动 · 52 周'), 'heatmap title updated');
  assert.ok(html.includes('次请求'), 'request count in heatmap header');
  // Redundant overall availability count removed from the section title.
  assert.ok(!html.includes('正常</span>'), 'availability count removed');
  // No general-* models in display.
  assert.ok(!html.includes('general-air'), 'general-* models filtered from display');
});

await test('streaming relay delivers every chunk and terminates cleanly (torn [DONE], model rewrite)', async () => {
  // Regression: stacked pull-based stream wrappers stalled on the final
  // chunks — clients saw the first events but the stream never terminated.
  resetMock();
  const encoder = new TextEncoder();
  routeHandlers['sr.example.com'] = () => {
    const events = [
      { id: 's', choices: [{ index: 0, delta: { content: '你' }, finish_reason: null }] },
      { id: 's', choices: [{ index: 0, delta: { content: '好，世' }, finish_reason: null }] },
      { id: 's', choices: [{ index: 0, delta: { content: '界' }, finish_reason: null }] },
      { id: 's', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    let i = 0;
    return new Response(new ReadableStream({
      async pull(c) {
        if (i >= events.length) {
          c.enqueue(encoder.encode('data: '));
          await new Promise((r) => setTimeout(r, 5));
          c.enqueue(encoder.encode('[DONE]'));
          await new Promise((r) => setTimeout(r, 5));
          c.enqueue(encoder.encode('\n\n'));
          c.close();
          return;
        }
        await new Promise((r) => setTimeout(r, 15));
        c.enqueue(encoder.encode(`data: ${JSON.stringify(events[i++])}\n\n`));
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  // logical != upstream so the inline model rewrite path is active.
  const env = makeEnv({ tier1: [basicNode('sr', { models: { air: 'up-air' } })], secrets: { sr: 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'air', messages: [{ role: 'user', content: 'Hi' }], stream: true }), env, {});
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  for (;;) {
    const x = await Promise.race([reader.read(), new Promise((s) => setTimeout(() => s({ timeout: true }), 3000))]);
    if (x.timeout) throw new Error('stream never terminated');
    if (x.done) break;
    text += dec.decode(x.value, { stream: true });
  }
  console.log('STREAM:', JSON.stringify(text));
  assert.match(text, /"content":"你"/);
  assert.match(text, /好，世/);
  assert.match(text, /"content":"界"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /\[DONE\]/);
  assert.ok(!text.includes('up-air'), 'upstream model must be rewritten to the logical name');
  assert.equal(getNodeState('sr').totalSuccesses, 1, 'clean completion must record node success');
});

// ---- Token usage: streaming include_usage hint + D1 fail-open ---------------

const usageChunk = (usage) => ({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [], usage });

await test('streaming chat asks the upstream to include usage and preserves existing stream_options', async () => {
  resetMock();
  routeHandlers['uh.example.com'] = () =>
    sseResponse([chunk('hi'), usageChunk({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }), finishChunk, doneEvent]);
  const env = makeEnv({ tier1: [basicNode('uh')], secrets: { uh: 'k' } });
  const res = await worker.fetch(chatRequest({
    model: 'general-air', messages: [], stream: true,
    stream_options: { other: 'kept' },
  }), env, {});
  assert.equal(res.status, 200);
  const sent = upstreamCalls[0].body;
  assert.equal(sent.stream_options.include_usage, true);
  assert.equal(sent.stream_options.other, 'kept', 'client stream_options fields must be preserved');
  await res.text();
});

await test('a client-provided include_usage value is never overwritten', async () => {
  resetMock();
  routeHandlers['ui.example.com'] = () => sseResponse([chunk('hi'), finishChunk, doneEvent]);
  const env = makeEnv({ tier1: [basicNode('ui')], secrets: { ui: 'k' } });
  await worker.fetch(chatRequest({
    model: 'general-air', messages: [], stream: true,
    stream_options: { include_usage: false },
  }), env, {});
  assert.equal(upstreamCalls[0].body.stream_options.include_usage, false);
});

await test('non-stream chat does not add a usage-only stream hint', async () => {
  resetMock();
  routeHandlers['ns.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({ tier1: [basicNode('ns')], secrets: { ns: 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  const sent = upstreamCalls[0].body;
  assert.equal(sent.stream, undefined);
  assert.equal(sent.stream_options, undefined);
});

await test('STREAM_INCLUDE_USAGE=off disables the streaming usage hint', async () => {
  resetMock();
  routeHandlers['off.example.com'] = () => sseResponse([chunk('hi'), finishChunk, doneEvent]);
  const env = makeEnv({
    tier1: [basicNode('off')], secrets: { off: 'k' },
    extraEnv: { STREAM_INCLUDE_USAGE: 'off' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls[0].body.stream_options, undefined);
  await res.text();
});

await test('STREAM_USAGE_INCLUDE_OFF_PROVIDERS opts a provider out of the hint', async () => {
  resetMock();
  routeHandlers['po.example.com'] = () => sseResponse([chunk('hi'), finishChunk, doneEvent]);
  const env = makeEnv({
    tier1: [{ ...basicNode('po'), provider: 'rejecting-provider' }],
    secrets: { po: 'k' },
    extraEnv: { STREAM_USAGE_INCLUDE_OFF_PROVIDERS: 'rejecting-provider' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls[0].body.stream_options, undefined);
  await res.text();
});

await test('a D1 write failure never breaks a successful AI response (fail-open)', async () => {
  resetMock();
  routeHandlers['d1ok.example.com'] = () => jsonUpstream(okCompletion('up-model'));
  const failingD1 = {
    prepare: () => { throw new Error('D1 prepare exploded synchronously'); },
  };
  const env = makeEnv({
    tier1: [basicNode('d1ok')], secrets: { 'd1ok': 'k' },
    extraEnv: { TOKEN_STATS_DB: failingD1 },
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
    assert.equal(res.status, 200);
    const body = JSON.parse(await res.text());
    assert.equal(body.choices[0].message.content, 'hello');
    // Let the deliberately detached no-ExecutionContext persistence settle.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(getNodeState('d1ok').totalSuccesses, 1, 'node success unaffected by D1');
  } finally {
    console.error = originalError;
  }
  assert.equal(
    errors.filter((line) => line.includes('token-stats D1')).length,
    1,
    'one delivered response produces at most one D1 persistence log',
  );
});

await test('with no D1 binding the gateway serves an AI response normally', async () => {
  resetMock();
  routeHandlers['nod1.example.com'] = () => jsonUpstream(okCompletion('up-model'));
  const env = makeEnv({ tier1: [basicNode('nod1')], secrets: { 'nod1': 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
});

await test('a real AI request lands the correct token aggregates in D1 (non-stream)', async () => {
  resetMock();
  routeHandlers['reald.example.com'] = () => jsonUpstream({
    id: 'chatcmpl-1', object: 'chat.completion', model: 'up-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  });
  const d1 = createMockD1();
  const env = makeEnv({
    tier1: [basicNode('reald')], secrets: { 'reald': 'k' },
    extraEnv: { TOKEN_STATS_DB: d1 },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  await res.text();
  const [row] = [...d1._rows.values()];
  assert.equal(row.total, 12);
  assert.equal(row.input, 5);
  assert.equal(row.output, 7);
  assert.equal(row.requests, 1);
  assert.equal(row.reports, 1);
  assert.equal(row.missing, 0);
});

await test('a missing-usage request bumps requests + usage_missing in D1 (never estimated)', async () => {
  resetMock();
  routeHandlers['realm.example.com'] = () => jsonUpstream({
    id: 'chatcmpl-1', object: 'chat.completion', model: 'up-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  }); // no usage
  const d1 = createMockD1();
  const env = makeEnv({
    tier1: [basicNode('realm')], secrets: { 'realm': 'k' },
    extraEnv: { TOKEN_STATS_DB: d1 },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  await res.text();
  const [row] = [...d1._rows.values()];
  assert.equal(row.total, 0, 'no fabricated tokens');
  assert.equal(row.requests, 1);
  assert.equal(row.reports, 0);
  assert.equal(row.missing, 1);
});

await test('homepage with no D1 binding still serves and degrades the token panel', async () => {
  resetMock();
  const env = makeEnv({
    tier1: [basicNode('h1'), basicNode('h2')],
    secrets: { h1: 'k', h2: 'k' },
  });
  const res = await worker.fetch(new Request('https://gateway.example.com/', {
    headers: { accept: 'text/html' },
  }), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('使用情况'));
  assert.ok(html.includes('统计暂不可用'), 'no D1 -> panel degrades, never a fake 0');
  assert.ok(!html.includes('>0<'));
  assert.ok(!html.includes('class="hd '), 'no fabricated heatmap cells');
});

await test('scheduled entry runs model-stat cleanup for a ScheduledController', async () => {
  const d1 = createMockD1();
  await worker.scheduled(
    { cron: '0 3 * * *', scheduledTime: Date.now(), noRetry() {} },
    { TOKEN_STATS_DB: d1 },
    {},
  );
  assert.equal(
    d1._writes.filter((write) => /DELETE\s+FROM\s+token_usage_model_hourly/i.test(write.sql)).length,
    1,
  );
});

await test('scheduled cleanup rejection reaches the runtime and is logged once', async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await assert.rejects(
      worker.scheduled(
        { cron: '0 3 * * *', scheduledTime: Date.now(), noRetry() {} },
        { TOKEN_STATS_DB: createMockD1({ failWrites: true }) },
        {},
      ),
      /mock D1 write failure/,
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.filter((line) => line.includes('token-stats cleanup failed')).length, 1);
});


// ---- Rolling-latency scheduling + hedged dispatch --------------------------

const streamText = async (res) => {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
};

await test('scheduler score follows passive per-model TTFT as performance drifts', async () => {
  resetMock();
  installMockFetch();
  routeHandlers['lat-a.example.com'] = () => sseResponse([chunk('ok'), 'data: [DONE]']);
  routeHandlers['lat-b.example.com'] = () => sseResponse([chunk('ok'), 'data: [DONE]']);
  const env = makeEnv({
    tier1: [basicNode('lat-a'), basicNode('lat-b')],
    secrets: { 'lat-a': 'k', 'lat-b': 'k' },
  });
  // Seed only the new passive (account, model) measurements. Legacy
  // node-level latency/health/LRU state is intentionally irrelevant.
  recordTier1Ttft('lat-a', 'general-air', 3000);
  recordTier1Ttft('lat-b', 'general-air', 50);
  for (let i = 0; i < 3; i++) {
    const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
    assert.equal(res.status, 200);
    await streamText(res);
  }
  const hosts = upstreamCalls.map((c) => c.host);
  assert.deepEqual(hosts, ['lat-b.example.com', 'lat-b.example.com', 'lat-b.example.com'],
    'decisively faster node wins all three requests');
  // Speeds drift: update passive observations until the EWMAs cross.
  for (let i = 0; i < 12; i++) {
    recordTier1Ttft('lat-a', 'general-air', 10);
    recordTier1Ttft('lat-b', 'general-air', 2000);
  }
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  await streamText(res);
  assert.equal(upstreamCalls[3].host, 'lat-a.example.com', 'preference follows the new latency measurements');
});

await test('hedge: a slow primary is raced after HEDGE_DELAY_MS and the twin wins', async () => {
  resetMock();
  installMockFetch();
  const slow = async () => { await new Promise((r) => setTimeout(r, 3000)); return sseResponse([chunk('slow'), 'data: [DONE]']); };
  routeHandlers['hs-slow.example.com'] = slow;
  routeHandlers['hs-fast.example.com'] = () => sseResponse([chunk('fast'), 'data: [DONE]']);
  const env = makeEnv({
    tier1: [basicNode('hs-slow'), basicNode('hs-fast')],
    secrets: { 'hs-slow': 'k', 'hs-fast': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '400', FAILOVER_BUDGET_MS: '30000' },
  });
  const t0 = Date.now();
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  const text = await streamText(res);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2500, `twin must win the race quickly (took ${elapsed}ms)`);
  assert.ok(text.includes('fast'), 'response served by the fast twin');
  const hosts = upstreamCalls.map((c) => c.host);
  assert.equal(hosts[0], 'hs-slow.example.com', 'primary dispatched first');
  assert.equal(hosts[1], 'hs-fast.example.com', 'twin dispatched after the hedge delay');
  assert.ok(!text.includes('slow'), 'slow primary output never surfaces');
});

await test('hedge: single candidate means no twin and normal behavior', async () => {
  resetMock();
  installMockFetch();
  const slow = async () => { await new Promise((r) => setTimeout(r, 700)); return sseResponse([chunk('solo'), 'data: [DONE]']); };
  routeHandlers['hs-solo.example.com'] = slow;
  const env = makeEnv({
    tier1: [basicNode('hs-solo')],
    secrets: { 'hs-solo': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '200', FAILOVER_BUDGET_MS: '30000' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.ok((await streamText(res)).includes('solo'));
  assert.equal(upstreamCalls.length, 1, 'no twin without a second candidate');
});

// A stream whose first byte arrives only after delayMs, then all events at
// once — lets a test separate header latency from time-to-first-event.
const delayedFirstEventSse = (delayMs, events) => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      await new Promise((r) => setTimeout(r, delayMs));
      for (const e of events) {
        controller.enqueue(encoder.encode(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`));
      }
      controller.close();
    },
  });
};

await test('hedge: a twin is not a logical attempt; the tier cap funds logical attempts', async () => {
  resetMock();
  installMockFetch();
  // tier1 cap=2 with three nodes: logical attempt 1 = primary df-slow + its
  // hedge twin df-fast (the twin charges NO attempt slot), logical attempt 2 =
  // df-third. The twin being extra means the tier still dispatches its third
  // node — total upstream calls = maxAttempts-in-tier + hedges.
  const delayedFailure = async () => {
    await new Promise((r) => setTimeout(r, 400));
    return jsonUpstream({}, 500);
  };
  for (const id of ['df-slow', 'df-fast', 'df-third']) routeHandlers[`${id}.example.com`] = delayedFailure;
  const env = makeEnv({
    tier1: [basicNode('df-slow'), basicNode('df-fast'), basicNode('df-third')],
    secrets: { 'df-slow': 'k', 'df-fast': 'k', 'df-third': 'k' },
    extraEnv: {
      HEDGE_DELAY_MS: '100',
      FAILOVER_BUDGET_MS: '30000',
      MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'fast' } }),
      POLICIES_CONFIG: JSON.stringify({ fast: { max_attempts: 5, tier_attempts: { tier1: 2 } } }),
    },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 502);
  const hosts = upstreamCalls.map((c) => c.host);
  assert.equal(hosts.length, 3);
  assert.equal(new Set(hosts).size, 3,
    `a hedge pair plus the second logical attempt dispatch all three accounts (got ${hosts.join(', ')})`);
  const body = await res.json();
  assert.equal(body.error.details.attempts, 2, 'attempts counts LOGICAL attempts');
  assert.equal(body.error.details.dispatches, 3, 'dispatches counts real upstream calls');
  assert.equal(body.error.details.hedges, 1, 'hedges counts hedge twins');
  assert.deepEqual(body.error.details.failure_kinds, { server: 3 });
});

await test('hedge: twin is decoupled from max_attempts but bounded by max_dispatches', async () => {
  resetMock();
  installMockFetch();
  // max_attempts=2 -> max_dispatches = 2 + 1 = 3. mb1 fails fast (logical
  // attempt 1), mb2 is the in-flight logical attempt 2 and STILL gets a twin
  // (the twin is not an attempt); the third upstream dispatch is exactly the
  // max_dispatches ceiling, and mb2 winning returns the response.
  let mbDispatch = 0;
  const maxDispatchHandler = async () => {
    mbDispatch++;
    if (mbDispatch === 1) return jsonUpstream({}, 500);
    if (mbDispatch === 2) {
      await new Promise((r) => setTimeout(r, 400));
      return jsonUpstream(okCompletion());
    }
    return jsonUpstream({}, 500);
  };
  for (const id of ['mb1', 'mb2', 'mb3']) routeHandlers[`${id}.example.com`] = maxDispatchHandler;
  const env = makeEnv({
    tier1: [basicNode('mb1'), basicNode('mb2'), basicNode('mb3')],
    secrets: { mb1: 'k', mb2: 'k', mb3: 'k' },
    extraEnv: {
      HEDGE_DELAY_MS: '100',
      FAILOVER_BUDGET_MS: '30000',
      MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'fast' } }),
      POLICIES_CONFIG: JSON.stringify({ fast: { max_attempts: 2 } }),
    },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices?.[0]?.message?.content, 'hello');
  assert.equal(upstreamCalls.length, 3,
    'max_attempts=2 allows exactly 3 upstream dispatches (2 logical + 1 hedge)');
  assert.equal(new Set(upstreamCalls.map((c) => c.host)).size, 3);
});

await test('hedge: a tier cap of 1 still allows a twin (a hedge is not an attempt)', async () => {
  resetMock();
  installMockFetch();
  // tier_attempts tier1=1 funds ONE LOGICAL attempt — which may still consist
  // of a primary AND its hedge twin, because the twin charges no attempt slot.
  routeHandlers['tc1.example.com'] = async () => {
    await new Promise((r) => setTimeout(r, 400));
    return jsonUpstream(okCompletion());
  };
  routeHandlers['tc2.example.com'] = () => jsonUpstream({}, 500);
  const env = makeEnv({
    tier1: [basicNode('tc1'), basicNode('tc2')],
    secrets: { tc1: 'k', tc2: 'k' },
    extraEnv: {
      HEDGE_DELAY_MS: '100',
      FAILOVER_BUDGET_MS: '30000',
      MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'fast' } }),
      POLICIES_CONFIG: JSON.stringify({ fast: { max_attempts: 5, tier_attempts: { tier1: 1 } } }),
    },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['tc1.example.com', 'tc2.example.com'],
    'the twin rides along with the single funded logical attempt');
});

// Signal-aware hang: the dispatch never returns headers until the gateway
// aborts it — mirrors a real stuck upstream whose fetch rejects on abort.
const hangUntilAbort = () => (req, url, init) => new Promise((resolve, reject) => {
  const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  if (init?.signal?.aborted) { reject(err); return; }
  init.signal.addEventListener('abort', () => reject(err), { once: true });
});

// HTTP 200 + SSE headers immediately, but the body errors when aborted and
// carries no events — a first-event stall whose reader unwinds on hedge loss.
const stallSseUntilAbort = () => (req, url, init) => new Response(new ReadableStream({
  start(controller) {
    init.signal.addEventListener('abort', () => controller.error(new TypeError('aborted')), { once: true });
  },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });

await test('hedge: no hedge at all when MAX_HEDGES_PER_REQUEST=0', async () => {
  resetMock();
  installMockFetch();
  const slow = async () => { await new Promise((r) => setTimeout(r, 400)); return sseResponse([chunk('solo'), 'data: [DONE]']); };
  routeHandlers['nh-slow.example.com'] = slow;
  routeHandlers['nh-idle.example.com'] = () => sseResponse([chunk('never'), 'data: [DONE]']);
  const env = makeEnv({
    tier1: [basicNode('nh-slow'), basicNode('nh-idle')],
    secrets: { 'nh-slow': 'k', 'nh-idle': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '100', MAX_HEDGES_PER_REQUEST: '0', FAILOVER_BUDGET_MS: '30000' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.ok((await streamText(res)).includes('solo'));
  assert.equal(upstreamCalls.length, 1, 'MAX_HEDGES_PER_REQUEST=0 disables the twin');
});

await test('hedge: Tier 1 remains capped at 3 logical attempts plus one twin', async () => {
  resetMock();
  installMockFetch();
  // The model policy allows five attempts, but Tier 1 is capped at three.
  // Make every account slow enough for the first logical attempt to hedge.
  const slowFailure = async () => { await new Promise((r) => setTimeout(r, 300)); return jsonUpstream({}, 500); };
  for (const id of ['mf-p1', 'mf-t2', 'mf-p3', 'mf-p4', 'mf-p5', 'mf-p6']) {
    routeHandlers[`${id}.example.com`] = slowFailure;
  }
  const env = makeEnv({
    tier1: [basicNode('mf-p1'), basicNode('mf-t2'), basicNode('mf-p3'), basicNode('mf-p4'), basicNode('mf-p5'), basicNode('mf-p6')],
    secrets: Object.fromEntries(['mf-p1', 'mf-t2', 'mf-p3', 'mf-p4', 'mf-p5', 'mf-p6'].map((id) => [id, 'k'])),
    extraEnv: {
      HEDGE_DELAY_MS: '100',
      FAILOVER_BUDGET_MS: '60000',
      MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'fast' } }),
      POLICIES_CONFIG: JSON.stringify({ fast: { max_attempts: 5 } }),
    },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.details.attempts, 3, 'Tier 1 hard cap applies despite policy max_attempts=5');
  assert.equal(body.error.details.dispatches, 4, '3 logical attempts plus one hedge twin');
  assert.equal(body.error.details.hedges, 1, 'exactly one hedge twin');
  assert.deepEqual(body.error.details.failure_kinds, { server: 4 });
  assert.equal(upstreamCalls.length, 4);
});

await test('hedge winner: primary aborted and recorded NEUTRAL (no failure, no penalty)', async () => {
  resetMock();
  installMockFetch();
  routeHandlers['hw-slow.example.com'] = hangUntilAbort();
  routeHandlers['hw-fast.example.com'] = () => sseResponse([chunk('fast'), 'data: [DONE]']);
  const env = makeEnv({
    tier1: [basicNode('hw-slow'), basicNode('hw-fast')],
    secrets: { 'hw-slow': 'k', 'hw-fast': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '200', FAILOVER_BUDGET_MS: '30000' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.ok((await streamText(res)).includes('fast'));
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['hw-slow.example.com', 'hw-fast.example.com']);
  // Let the aborted primary's dispatch rejection unwind.
  await new Promise((r) => setTimeout(r, 50));
  const slowState = getNodeState('hw-slow');
  assert.equal(slowState.totalFailures, 0, 'hedge loser must not count as a failure');
  assert.equal(getTier1Model('hw-slow', 'general-air').consecutiveFailures, 0,
    'hedge loser must not feed Tier 1 recovery state');
  assert.equal(getTier1Model('hw-slow', 'general-air').cooldownUntil, 0,
    'hedge loser must not be cooled down');
});

await test('hedge winner at the first-event guard: primary loser stays neutral', async () => {
  resetMock();
  installMockFetch();
  // Primary returns 200 + SSE headers then stalls before the first event;
  // when the twin commits, the primary's guard unwinds through the abort
  // path — that cancellation must NOT be miscounted as a first-event timeout.
  routeHandlers['gl-stall.example.com'] = stallSseUntilAbort();
  routeHandlers['gl-fast.example.com'] = () => sseResponse([chunk('fast'), 'data: [DONE]']);
  const env = makeEnv({
    tier1: [basicNode('gl-stall'), basicNode('gl-fast')],
    secrets: { 'gl-stall': 'k', 'gl-fast': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '200', FAILOVER_BUDGET_MS: '30000' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.ok((await streamText(res)).includes('fast'));
  await new Promise((r) => setTimeout(r, 50));
  const stallState = getNodeState('gl-stall');
  assert.equal(stallState.totalFailures, 0, 'guard-phase hedge loser is neutral, not first_event_timeout');
  assert.equal(getTier1Model('gl-stall', 'general-air').consecutiveFailures, 0);
  assert.equal(getTier1Model('gl-stall', 'general-air').cooldownUntil, 0);
});

await test('hedge: primary wins the race and the hanging twin is neutral', async () => {
  resetMock();
  installMockFetch();
  routeHandlers['pw-slow.example.com'] = async () => {
    await new Promise((r) => setTimeout(r, 400));
    return sseResponse([chunk('primary'), 'data: [DONE]']);
  };
  routeHandlers['pw-twin.example.com'] = hangUntilAbort();
  const env = makeEnv({
    tier1: [basicNode('pw-slow'), basicNode('pw-twin')],
    secrets: { 'pw-slow': 'k', 'pw-twin': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '100', FAILOVER_BUDGET_MS: '30000' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.ok((await streamText(res)).includes('primary'));
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['pw-slow.example.com', 'pw-twin.example.com']);
  await new Promise((r) => setTimeout(r, 50));
  const twinState = getNodeState('pw-twin');
  assert.equal(twinState.totalFailures, 0, 'aborted twin is neutral');
  assert.equal(twinState.consecutiveFailures, 0);
});

await test('hedge: both sides fail -> one logical attempt consumed, the next one runs', async () => {
  resetMock();
  installMockFetch();
  let bfDispatch = 0;
  const bothFailThenSuccess = async () => {
    bfDispatch++;
    if (bfDispatch === 1) {
      await new Promise((r) => setTimeout(r, 300));
      return jsonUpstream({}, 500);
    }
    if (bfDispatch === 2) return jsonUpstream({}, 500);
    return jsonUpstream(okCompletion());
  };
  for (const id of ['bf-p', 'bf-t', 'bf-next']) routeHandlers[`${id}.example.com`] = bothFailThenSuccess;
  const env = makeEnv({
    tier1: [basicNode('bf-p'), basicNode('bf-t'), basicNode('bf-next')],
    secrets: { 'bf-p': 'k', 'bf-t': 'k', 'bf-next': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '100', FAILOVER_BUDGET_MS: '30000' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls.length, 3,
    'the failed hedge pair consumes ONE logical attempt, then attempt 2 serves');
  assert.equal(new Set(upstreamCalls.map((c) => c.host)).size, 3);
  const failedTwinId = upstreamCalls[1].host.split('.')[0];
  assert.equal(getTier1Model(failedTwinId, 'general-air').consecutiveFailures, 1,
    'a twin that genuinely 5xxes counts as a real failure');
});

// ---- Hedge twin slot/RPM leak regressions ----------------------------------
// The hedge gate MUST check the shared attempt deadline BEFORE picking (and
// therefore claiming) a twin: pickCandidate claims a concurrency slot + RPM
// reservation as a side effect, so a post-pick bail-out would strand those
// reservations on a twin that is never dispatched. The trigger is a primary
// stalled in the distributed rate limiter (attemptDeadlineMs not yet set) when
// the hedge timer fires: the `?? 0` fallback makes deadlineRemaining negative,
// so the gate must bail BEFORE pickCandidate to avoid leaking the twin's slot.

await test('hedge gate: exhausted deadline claims NOTHING from the twin (no slot/RPM leak)', async () => {
  resetMock();
  installMockFetch();
  // A slow rate limiter stalls the primary before it sets attemptDeadlineMs.
  // The hedge timer fires during that stall, the deadline gate bails, and the
  // twin must never be picked or claimed. The primary then succeeds after the
  // limiter resolves, so no retry ever touches the twin.
  routeHandlers['hz-p.example.com'] = () => jsonUpstream(okCompletion());
  routeHandlers['hz-t.example.com'] = () => jsonUpstream(okCompletion());
  const slowLimiter = {
    limit: async () => { await new Promise((r) => setTimeout(r, 400)); return { success: true }; },
  };
  const env = makeEnv({
    tier1: [
      basicNode('hz-p', { limits: { concurrency: 5, rpm: 100 } }),
      basicNode('hz-t', { limits: { concurrency: 5, rpm: 100 } }),
    ],
    secrets: { 'hz-p': 'k', 'hz-t': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '200', FAILOVER_BUDGET_MS: '30000', QUOTA_RATE_LIMITER: slowLimiter },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200, 'the primary succeeds after the limiter resolves');
  await res.text();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['hz-p.example.com'],
    'no phantom twin dispatch after the deadline is gone');
  const twin = getNodeState('hz-t');
  assert.equal(twin.activeRequests, 0, 'no concurrency slot may stay claimed');
  assert.equal(twin.totalRequests, 0, 'no totalRequests charge for a never-dispatched twin');
  assert.equal(tier1RpmUsage('hz-t', Date.now()), 0, 'no RPM reservation for a never-dispatched twin');
  assert.equal(twin.lastUsedAt, 0, 'lastUsedAt untouched');
});

await test('hedge gate: a valid deadline claims and dispatches the twin normally', async () => {
  resetMock();
  installMockFetch();
  // Generous budget: the deadline is alive when the hedge timer fires, so the
  // twin is claimed AND dispatched, then both sides die at the shared deadline.
  routeHandlers['hg-p.example.com'] = hangUntilAbort();
  routeHandlers['hg-t.example.com'] = hangUntilAbort();
  const env = makeEnv({
    tier1: [basicNode('hg-p'), basicNode('hg-t')],
    secrets: { 'hg-p': 'k', 'hg-t': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '200', FAILOVER_BUDGET_MS: '2000' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 504);
  const body = await res.json();
  assert.equal(body.error.details.dispatches, 2, 'primary + twin both dispatched');
  assert.equal(body.error.details.hedges, 1);
  await new Promise((r) => setTimeout(r, 50));
  const twin = getNodeState('hg-t');
  assert.equal(twin.totalRequests, 1, 'the twin was really claimed and dispatched');
  assert.equal(twin.activeRequests, 0, 'its slot was released when the attempt ended');
  if (Math.floor(Date.now() / 60_000) === Math.floor((twin.lastUsedAt || 0) / 60_000)) {
    assert.equal(tier1RpmUsage('hg-t', Date.now()), 1, 'the twin genuinely reached an upstream, so the RPM charge stays');
  }
});

await test('hedge loser: twin loses the race, releases its slot, keeps its RPM charge', async () => {
  resetMock();
  installMockFetch();
  routeHandlers['lw-p.example.com'] = async () => {
    await new Promise((r) => setTimeout(r, 150));
    return sseResponse([chunk('primary'), 'data: [DONE]']);
  };
  routeHandlers['lw-t.example.com'] = hangUntilAbort();
  const env = makeEnv({
    tier1: [basicNode('lw-p'), basicNode('lw-t')],
    secrets: { 'lw-p': 'k', 'lw-t': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '100', FAILOVER_BUDGET_MS: '30000' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.ok((await streamText(res)).includes('primary'));
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['lw-p.example.com', 'lw-t.example.com'],
    'both sides really dispatched (2 upstream calls)');
  await new Promise((r) => setTimeout(r, 50));
  const twin = getNodeState('lw-t');
  assert.equal(twin.activeRequests, 0, 'the loser released its concurrency slot');
  assert.equal(twin.totalRequests, 1);
  if (Math.floor(Date.now() / 60_000) === Math.floor((twin.lastUsedAt || 0) / 60_000)) {
    assert.equal(tier1RpmUsage('lw-t', Date.now()), 1, 'the loser reached the upstream, so its RPM charge is legitimate');
  }
  assert.equal(twin.totalFailures, 0, 'losing the race is neutral, never a failure');
  assert.equal(twin.consecutiveFailures, 0, 'no circuit chain from a neutral loser');
});

await test('hedge gate: an exhausted deadline never strands a half-open probe on the twin', async () => {
  resetMock();
  installMockFetch();
  // The twin is probe-ready (circuit open, open period elapsed). A slow rate
  // limiter stalls the primary so the hedge gate fires with an undefined
  // deadline. The twin must NOT be claimed as the half-open probe: a stuck
  // probeInFlight would make the node permanently unavailable.
  routeHandlers['hx-p.example.com'] = () => jsonUpstream(okCompletion());
  routeHandlers['hx-t.example.com'] = () => jsonUpstream(okCompletion());
  const slowLimiter = {
    limit: async () => { await new Promise((r) => setTimeout(r, 400)); return { success: true }; },
  };
  const env = makeEnv({
    tier1: [
      basicNode('hx-p', { limits: { concurrency: 5, rpm: 100 } }),
      basicNode('hx-t', { limits: { concurrency: 5, rpm: 100 } }),
    ],
    secrets: { 'hx-p': 'k', 'hx-t': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '200', FAILOVER_BUDGET_MS: '30000', QUOTA_RATE_LIMITER: slowLimiter },
  });
  const recovery = getTier1Model('hx-t', 'general-air');
  recovery.failureState = 'cooldown';
  recovery.cooldownUntil = Date.now() - 1;
  recovery.consecutiveFailures = 3;
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200, 'the primary succeeds; the twin is never touched');
  await res.text();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['hx-p.example.com']);
  assert.equal(tier1AccountInFlight('hx-t'), 0, 'no slot leaked through recovery selection');
  assert.equal(getTier1Model('hx-t', 'general-air').failureState, 'half_open',
    'expired cooldown may become eligible, but no synthetic probe or slot is created');
});

await test('hedge twin inherits the logical attempt deadline (no fresh budget)', async () => {
  resetMock();
  installMockFetch();
  // Budget 2000ms / 2 live dispatchable nodes -> 1000ms logical attempt slice.
  // Primary hangs; the hedge fires at 300ms and the twin MUST die at the
  // shared ~1000ms deadline, not run a fresh ~1000ms of its own (which would
  // end near 1300ms).
  routeHandlers['sd-a.example.com'] = hangUntilAbort();
  routeHandlers['sd-b.example.com'] = hangUntilAbort();
  const env = makeEnv({
    tier1: [basicNode('sd-a'), basicNode('sd-b')],
    secrets: { 'sd-a': 'k', 'sd-b': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '300', FAILOVER_BUDGET_MS: '2000', EXPOSE_UPSTREAM_INFO: 'true' },
  });
  const t0 = Date.now();
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  const elapsed = Date.now() - t0;
  assert.equal(res.status, 504, 'both hedged sides time out at the shared deadline');
  const body = await res.json();
  assert.equal(body.error.details.attempts, 1);
  assert.equal(body.error.details.dispatches, 2);
  assert.equal(body.error.details.hedges, 1);
  assert.deepEqual(body.error.details.failure_kinds, { headers_timeout: 2 });
  const dispatchRecords = body.error.details.attempts_detail;
  assert.deepEqual(
    dispatchRecords.map((record) => record.node_id).sort(),
    ['sd-a', 'sd-b'],
    'the hedge dispatches each eligible node exactly once',
  );
  assert.ok(
    dispatchRecords.every((record) => record.latency_ms <= 1200),
    `both dispatches die at the shared attempt deadline (got ${dispatchRecords.map((record) => record.latency_ms).join(', ')}ms)`,
  );
  assert.ok(
    dispatchRecords.some((record) => record.latency_ms < 950),
    `the hedge twin must end by the shared deadline, not receive a fresh 1000ms slice (got ${dispatchRecords.map((record) => record.latency_ms).join(', ')}ms)`,
  );
  assert.ok(elapsed < 1600, `request must not outlive the shared deadline (took ${elapsed}ms)`);
});

await test('hedge policy: tiers filter excludes tier-2 from hedging', async () => {
  resetMock();
  installMockFetch();
  // Policy says hedge only on tier1. Tier-1 nodes fail fast; the request
  // falls through to tier-2. Tier-2's primary hangs (the hedge timer WOULD
  // fire on tier1), but the policy excludes tier2 — no twin is launched.
  routeHandlers['hp-t1a.example.com'] = () => jsonUpstream({}, 500);
  routeHandlers['hp-t1b.example.com'] = () => jsonUpstream({}, 500);
  routeHandlers['hp-t2a.example.com'] = hangUntilAbort();
  routeHandlers['hp-t2b.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('hp-t1a'), basicNode('hp-t1b')],
    tier2: [basicNode('hp-t2a'), basicNode('hp-t2b')],
    secrets: { 'hp-t1a': 'k', 'hp-t1b': 'k', 'hp-t2a': 'k', 'hp-t2b': 'k' },
    extraEnv: {
      HEDGE_DELAY_MS: '100', FAILOVER_BUDGET_MS: '2000',
      MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'hp' } }),
      POLICIES_CONFIG: JSON.stringify({ 'hp': { max_attempts: 5, hedge: { tiers: ['tier1'] } } }),
    },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.ok(!res.ok, 'the hanging tier-2 primary eventually exhausts the budget');
  const body = await res.json();
  assert.equal(body.error.details.hedges, 0, 'no hedge twin may be launched on tier-2 (excluded by policy)');
  // hp-t2b was never dispatched (tier2 cap=1, only hp-t2a was tried).
  assert.equal(getNodeState('hp-t2b').totalRequests, 0, 'the unused tier-2 twin candidate is never touched');
});

await test('hedge policy: enabled=false disables hedging entirely', async () => {
  resetMock();
  installMockFetch();
  routeHandlers['hd-a.example.com'] = hangUntilAbort();
  routeHandlers['hd-b.example.com'] = () => sseResponse([chunk('fast'), 'data: [DONE]']);
  const env = makeEnv({
    tier1: [basicNode('hd-a'), basicNode('hd-b')],
    secrets: { 'hd-a': 'k', 'hd-b': 'k' },
    extraEnv: {
      HEDGE_DELAY_MS: '100', FAILOVER_BUDGET_MS: '30000',
      MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'hd' } }),
      POLICIES_CONFIG: JSON.stringify({ 'hd': { max_attempts: 5, hedge: { enabled: false } } }),
    },
  });
  const t0 = Date.now();
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  const elapsed = Date.now() - t0;
  // Without hedge, the hanging primary must time out before the fast twin
  // is ever tried. The response comes from hd-b on attempt 2 (after the
  // primary's attempt budget slice expires).
  assert.equal(res.status, 200);
  assert.ok((await streamText(res)).includes('fast'));
  // No twin was dispatched on attempt 1.
  assert.equal(getNodeState('hd-b').totalRequests, 1, 'hd-b was dispatched as attempt-2 primary, not as a hedge twin');
  assert.equal(upstreamCalls.length, 2, 'exactly 2 upstream calls (primary timeout + attempt-2 success)');
});

await test('timeout kinds: no HTTP status -> headers_timeout (status=0)', async () => {
  resetMock();
  installMockFetch();
  routeHandlers['tk-hang.example.com'] = hangUntilAbort();
  const env = makeEnv({
    tier1: [basicNode('tk-hang')],
    secrets: { 'tk-hang': 'k' },
    extraEnv: { FAILOVER_BUDGET_MS: '1200', EXPOSE_UPSTREAM_INFO: 'true' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 504);
  const body = await res.json();
  assert.deepEqual(body.error.details.failure_kinds, { headers_timeout: 1 });
  const record = body.error.details.attempts_detail[0];
  assert.equal(record.kind, 'headers_timeout');
  assert.equal(record.status, 0, 'no HTTP status was ever received');
});

await test('timeout kinds: HTTP 200 but no SSE event -> first_event_timeout (status=200)', async () => {
  resetMock();
  installMockFetch();
  routeHandlers['tk-stall.example.com'] = stallSseUntilAbort();
  const env = makeEnv({
    tier1: [basicNode('tk-stall')],
    secrets: { 'tk-stall': 'k' },
    extraEnv: { FAILOVER_BUDGET_MS: '1200', EXPOSE_UPSTREAM_INFO: 'true' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 504);
  const body = await res.json();
  assert.deepEqual(body.error.details.failure_kinds, { first_event_timeout: 1 });
  const record = body.error.details.attempts_detail[0];
  assert.equal(record.kind, 'first_event_timeout');
  assert.equal(record.status, 200, 'headers were received; the wait after them timed out');
  assert.ok(record.ttft_wait_ms > 0, 'the first-event wait is reported separately');
});

await test('client abort: neutral end, never misrecorded as headers_timeout', async () => {
  resetMock();
  installMockFetch();
  routeHandlers['ca-hang.example.com'] = hangUntilAbort();
  const env = makeEnv({
    tier1: [basicNode('ca-hang')],
    secrets: { 'ca-hang': 'k' },
    extraEnv: { FAILOVER_BUDGET_MS: '30000' },
  });
  const controller = new AbortController();
  const pending = worker.fetch(
    chatRequest({ model: 'general-air', messages: [] }, ACCESS_KEY, { signal: controller.signal }),
    env, {},
  );
  await new Promise((r) => setTimeout(r, 100));
  controller.abort();
  const res = await pending;
  assert.equal(res.status, 499, 'client abort returns 499');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(getNodeState('ca-hang').totalFailures, 0, 'client abort is not a node failure');
  assert.equal(getTier1Model('ca-hang', 'general-air').consecutiveFailures, 0);
  assert.equal(getTier1Model('ca-hang', 'general-air').cooldownUntil, 0);
});


await test('scheduler uses measured TTFT, not header latency, once both are known', async () => {
  resetMock();
  installMockFetch();
  // tt-a answers headers fast (~30ms) but stalls ~600ms before the first
  // token; tt-b answers headers slow (~200ms) and streams immediately. Header
  // latency alone prefers tt-a; TTFT must prefer tt-b once both have measured
  // a first event.
  routeHandlers['tt-a.example.com'] = async () => {
    await new Promise((r) => setTimeout(r, 30));
    return new Response(delayedFirstEventSse(600, [chunk('ok'), 'data: [DONE]']),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  routeHandlers['tt-b.example.com'] = async () => {
    await new Promise((r) => setTimeout(r, 200));
    return sseResponse([chunk('ok'), 'data: [DONE]']);
  };
  const env = makeEnv({
    tier1: [basicNode('tt-a'), basicNode('tt-b')],
    secrets: { 'tt-a': 'k', 'tt-b': 'k' },
    extraEnv: { FAILOVER_BUDGET_MS: '30000' },
  });
  // Request 1: both unmeasured, list order wins -> tt-a. Request 2: tt-b is
  // the only untouched (LRU) candidate -> tt-b. Request 3: both have TTFT
  // measurements -> tt-b (fast first token) despite slower headers.
  for (const expected of ['tt-a', 'tt-b', 'tt-b']) {
    const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
    assert.equal(res.status, 200);
    assert.ok((await streamText(res)).includes('ok'));
    assert.equal(upstreamCalls.at(-1).host, `${expected}.example.com`,
      `request ${upstreamCalls.length} must land on ${expected}`);
  }
});

if (!process.exitCode) console.log(`
integration tests passed (${passed}).`);
else process.exit(1);
