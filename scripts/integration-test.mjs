#!/usr/bin/env node
// Black-box integration tests: run the REAL worker pipeline
// (auth -> scheduler -> retry -> circuit -> protocol -> stream) through
// worker.fetch() against a mocked global fetch upstream.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../src/index.ts';
import { __resetAllStateForTests, getNodeState, noteRpmRequest } from '../src/reliability/node-state.ts';
import {
  __resetTier1StateForTests, tier1AccountInFlight,
  getTier1Account, getTier1Model, snapshotTier1Runtime, recordTier1Ttft, tier1RpmUsage,
} from '../src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.ts';
import { createMockD1 } from './mock-d1-database.mjs';
import { persistTokenUsage } from '../src/observability/token-usage-store.ts';

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
    return handler(req ?? {}, url, init);
  };
}

function resetMock() {
  upstreamCalls.length = 0;
  routeHandlers = {};
}

function makeEnv({ tier1, tier2, tier3, secrets, extraEnv } = {}) {
  const tierSecrets = (nodes = []) => Object.fromEntries(
    nodes
      .map((node) => [node.id, secrets?.[node.id]])
      .filter(([, credential]) => credential !== undefined),
  );
  const tier1Secrets = tierSecrets(tier1);
  const tier2Secrets = tierSecrets(tier2);
  const tier3Secrets = tierSecrets(tier3);
  return {
    GATEWAY_ACCESS_KEY_AIR: ACCESS_KEY,
    GATEWAY_ACCESS_MODELS_AIR: '*',
    TIER1_SCHEDULER_SEED: 'integration-test',
    ...(tier1 ? { TIER1_NODES_CONFIG_01: JSON.stringify(tier1) } : {}),
    ...(tier2 ? { TIER2_NODES_CONFIG_01: JSON.stringify(tier2) } : {}),
    ...(tier3 ? { TIER3_NODES_CONFIG_01: JSON.stringify(tier3) } : {}),
    ...(Object.keys(tier1Secrets).length ? { TIER1_NODES_SECRETS_01: JSON.stringify(tier1Secrets) } : {}),
    ...(Object.keys(tier2Secrets).length ? { TIER2_NODES_SECRETS_01: JSON.stringify(tier2Secrets) } : {}),
    ...(Object.keys(tier3Secrets).length ? { TIER3_NODES_SECRETS_01: JSON.stringify(tier3Secrets) } : {}),
    ...extraEnv,
  };
}

// Helper: create env with hedging explicitly enabled for the default policy.
// Built-in default/stable enable Tier 1 hedge; fast/long-reasoning do not.
// This helper allows overriding hedge config for tests that need specific
// hedge behavior (e.g. tier2 hedging, custom delay) beyond the builtin default.
function makeEnvWithHedge({ tier1, tier2, tier3, secrets, extraEnv, hedgeConfig } = {}) {
  const hedge = hedgeConfig ?? { enabled: true, tiers: ['tier1', 'tier2'] };
  return makeEnv({
    tier1, tier2, tier3, secrets,
    extraEnv: {
      POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 5, hedge } }),
      ...extraEnv,
    },
  });
}

const basicNode = (id, extra = {}) => ({
  id,
  provider: 'mock',
  base_url: `https://${id}.example.com/v1`,
  models: { 'general-air': 'up-model' },
  ...extra,
});

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
  assert.equal(upstreamCalls.length, 1);
  assert.notEqual(upstreamCalls[0].host, 'a10.example.com');
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
  assert.equal(body.model, 'general-air');
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
    tier1: ids.map((id) => basicNode(id)),
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
  assert.ok(served.every((id) => ids.includes(id)));
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
  assert.deepEqual(nodes, ['rpm-a', 'rpm-b']);
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
    assert.equal(res.status, 200);
  }
});

await test('RPM hard mode never exceeds the configured cap: exhaustion yields 503 at the minute boundary', async () => {
  resetMock();
  routeHandlers['hard.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('hard', { limits: { concurrency: 5, rpm: 1 } })],
    secrets: { hard: 'k' },
  });
  const first = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(first.status, 200);
  const second = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(second.status, 503);
  const retryAfter = Number(second.headers.get('retry-after'));
  assert.ok(retryAfter >= 1 && retryAfter <= 60);
  assert.equal(upstreamCalls.length, 1);
});

await test('global QUOTA_RATE_LIMITER deny rotates without counting a node failure', async () => {
  resetMock();
  routeHandlers['gb-a.example.com'] = () => jsonUpstream(okCompletion());
  routeHandlers['gb-b.example.com'] = () => jsonUpstream(okCompletion());
  const fakeBinding = { limit: async ({ key }) => ({ success: key !== 'gb-a' }) };
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
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['gb-b.example.com']);
  assert.equal(getNodeState('gb-a').totalFailures, 0);
  assert.equal(tier1RpmUsage('gb-a'), 0);
});

await test('all nodes denied by distributed limiter returns 429 with a window-based Retry-After', async () => {
  resetMock();
  routeHandlers['ga1.example.com'] = () => jsonUpstream(okCompletion());
  routeHandlers['ga2.example.com'] = () => jsonUpstream(okCompletion());
  const fakeBinding = { limit: async () => ({ success: false }) };
  const env = makeEnv({
    tier1: [basicNode('ga1', { limits: { concurrency: 5, rpm: 100 } }), basicNode('ga2', { limits: { concurrency: 5, rpm: 100 } })],
    secrets: { ga1: 'k', ga2: 'k' },
    extraEnv: { QUOTA_RATE_LIMITER: fakeBinding },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 429);
  const retryAfter = Number(res.headers.get('retry-after'));
  assert.ok(retryAfter >= 1 && retryAfter <= 60);
  assert.deepEqual(upstreamCalls, []);
});

await test('pre-dispatch denies charge no budget: Tier1 drain continues, Tier2 never entered', async () => {
  resetMock();
  const deniedIds = ['db1', 'db2', 'db3', 'db4'];
  routeHandlers['db-ok.example.com'] = () => jsonUpstream(okCompletion());
  routeHandlers['t2.example.com'] = () => jsonUpstream(okCompletion());
  const fakeBinding = { limit: async ({ key }) => ({ success: !deniedIds.includes(key) }) };
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
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['db-ok.example.com']);
  assert.equal(getNodeState('db1').totalFailures, 0);
  assert.equal(tier1RpmUsage('db1'), 0);
});

await test('hard-RPM-exhausted fallback tier is skipped and Tier 1 uses the shared max_attempts budget', async () => {
  resetMock();
  for (let i = 1; i <= 6; i++) routeHandlers[`rp${i}.example.com`] = () => jsonUpstream({}, 502);
  routeHandlers['rpmex-t2.example.com'] = () => jsonUpstream(okCompletion());
  noteRpmRequest('rpmex-t2', Date.now());
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
  assert.equal(body.error.details.attempts, 5, 'Tier 1 may use all five shared attempts');
  const hosts = upstreamCalls.map((c) => c.host);
  assert.equal(hosts.length, 5);
  assert.ok(hosts.every((h) => /^rp[1-6]\.example\.com$/.test(h)));
  assert.ok(!hosts.includes('rpmex-t2.example.com'));
});

await test('concurrency-saturated fallback tier is skipped while Tier 1 uses the shared max_attempts budget', async () => {
  resetMock();
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
  for (let i = 0; i < 100 && !upstreamCalls.some((c) => c.host === 'sat2.example.com'); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(upstreamCalls.some((c) => c.host === 'sat2.example.com'));

  const baseline = upstreamCalls.length;
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.details.attempts, 5, 'Tier 1 may use all five shared attempts');
  const hosts = upstreamCalls.slice(baseline).map((c) => c.host);
  assert.equal(hosts.length, 5);
  assert.ok(hosts.every((h) => /^cs[1-6]\.example\.com$/.test(h)));

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
  await new Promise((r) => setTimeout(r, 10));
  const second = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  release();
  assert.equal(await first.then((r) => r.status), 200);
  assert.equal(second.status, 503);
  assert.equal(second.headers.get('retry-after'), '1');
});

await test('Retry-After takes the min across blocking reasons, filtered by model', async () => {
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
  const hold = worker.fetch(chatRequest({ model: 'code-pro', messages: [] }), env, {});
  await new Promise((r) => setTimeout(r, 10));
  await worker.fetch(chatRequest({ model: 'code-pro', messages: [] }), env, {});
  await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  const res = await worker.fetch(chatRequest({ model: 'code-pro', messages: [] }), env, {});
  release();
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '1');
  await hold;
});

await test('anthropic-route exhaustion errors are Anthropic-shaped', async () => {
  resetMock();
  routeHandlers['anx.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': '30' });
  const env = makeEnv({ tier1: [anthropicNode('anx', { models: { 'general-air': 'up-model' } })], secrets: { anx: 'k' } });
  const makeReq = () => new Request('https://gateway.example.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ACCESS_KEY },
    body: JSON.stringify({ model: 'general-air', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });
  await worker.fetch(makeReq(), env, {});
  const res = await worker.fetch(makeReq(), env, {});
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'rate_limit_error');
});

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
  routeHandlers['mm1.example.com'] = async (req) => {
    const body = JSON.parse(await req.text());
    if (body.model === 'up-code') return jsonUpstream({ error: { message: 'Model not found' } }, 404);
    return jsonUpstream(okCompletion());
  };
  const env = makeEnv({
    tier1: [{ ...basicNode('mm1'), models: { 'code-pro': 'up-code', 'general-air': 'up-air' } }],
    secrets: { mm1: 'k' },
  });
  const r1 = await worker.fetch(chatRequest({ model: 'code-pro', messages: [] }), env, {});
  assert.equal(r1.status, 502);
  assert.equal(getTier1Account('mm1').accountDisabled, false);
  assert.equal(getTier1Model('mm1', 'code-pro').disabled, false);
  assert.equal(getTier1Model('mm1', 'code-pro').failureState, 'cooldown');
  assert.ok(getTier1Model('mm1', 'code-pro').cooldownUntil > Date.now());
  const r2 = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(r2.status, 200);
  assert.equal(upstreamCalls[upstreamCalls.length - 1].host, 'mm1.example.com');
  const callsBefore = upstreamCalls.length;
  await worker.fetch(chatRequest({ model: 'code-pro', messages: [] }), env, {});
  assert.equal(upstreamCalls.length, callsBefore);
});

await test('404 endpoint not found cools the whole Tier 1 account', async () => {
  resetMock();
  routeHandlers['ep1.example.com'] = () => jsonUpstream({}, 404);
  const env = makeEnv({
    tier1: [{ ...basicNode('ep1'), models: { 'code-pro': 'up-c', 'general-air': 'up-a' } }],
    secrets: { ep1: 'k' },
  });
  const r1 = await worker.fetch(chatRequest({ model: 'code-pro', messages: [] }), env, {});
  assert.equal(r1.status, 502);
  assert.ok(getTier1Account('ep1').accountCooldownUntil > Date.now());
  assert.equal(getTier1Model('ep1', 'code-pro').cooldownUntil, 0);
  const r2 = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.notEqual(r2.status, 200);
});

await test('Retry-After seconds sets model cooldown window', async () => {
  resetMock();
  routeHandlers['ra.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': '90' });
  const env = makeEnv({ tier1: [basicNode('ra')], secrets: { ra: 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 429);
  const remaining = getTier1Model('ra', 'general-air').cooldownUntil - Date.now();
  assert.ok(remaining > 80_000 && remaining <= 90_000);
});

await test('Retry-After HTTP-date sets model cooldown', async () => {
  resetMock();
  const date = new Date(Date.now() + 45_000).toUTCString();
  routeHandlers['rd.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': date });
  const env = makeEnv({ tier1: [basicNode('rd')], secrets: { rd: 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 429);
  const remaining = getTier1Model('rd', 'general-air').cooldownUntil - Date.now();
  assert.ok(remaining > 35_000 && remaining <= 46_000);
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
  assert.equal([...stored.values()][0], 'aff-t1');
  __resetTier1AffinityForTests();
  tier1Healthy = false;
  const second = await worker.fetch(request(), env, {});
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-gateway-node'), 'aff-t2');
  await second.text();
  assert.equal([...stored.values()][0], 'aff-t1');
});

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
  const blocked = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(blocked.status, 429);
  assert.equal(upstreamCalls.length, 3);
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
  assert.equal(tier1AccountInFlight('life-ok'), 1);
  const reader = res.body.getReader();
  await reader.read();
  assert.equal(tier1AccountInFlight('life-ok'), 1);
  controlled.complete();
  while (!(await reader.read()).done) { /* drain */ }
  assert.equal(tier1AccountInFlight('life-ok'), 0);
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
  });
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
  assert.ok(!upstreamCalls.some((c) => c.host === 'mid-b.example.com'));
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
  assert.equal(body.content[0].text, 'hello');
  assert.equal(body.usage.input_tokens, 1);
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
  assert.ok(!text.includes('up-model'));
  assert.ok(text.includes('"model":"claude-x"'));
});

await test('clean close without [DONE] is accounted as node failure', async () => {
  resetMock();
  const encoder = new TextEncoder();
  routeHandlers['trunc.example.com'] = () => new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk('partial output'))}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const env = makeEnv({ tier1: [basicNode('trunc')], secrets: { trunc: 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  const delivered = await res.text();
  assert.match(delivered, /"code":"stream_interrupted"/);
  const s = getNodeState('trunc');
  assert.equal(s.totalFailures, 1);
  assert.equal(s.totalSuccesses, 0);
});

async function metricValue(env, name) {
  const res = await worker.fetch(new Request('https://gateway.example.com/metrics', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
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
      controller.close();
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
  assert.equal(d.gateway_stream_started_total, 1);
  assert.equal(d.gateway_stream_completed_total, 1);
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
  assert.equal(getNodeState('seof').totalFailures, 1);
});

await test('mid-stream upstream crash preserves reader_error through the replay guard', async () => {
  resetMock();
  const encoder = new TextEncoder();
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
  const d = await deltaSince();
  assert.equal(d.gateway_stream_interrupted_total, 1);
  assert.equal(d.gateway_stream_missing_completion_marker_total, 0);
  assert.equal(d.gateway_stream_reader_error_total, 1);
  assert.equal(d.gateway_stream_idle_timeout_total, 0);
  assert.equal(getNodeState('rerr').totalFailures, 1);
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
  assert.equal(s.failureState, 'cooldown');
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
  assert.equal(getNodeState('cab').totalFailures, 0);
});

await test('public home is served but never leaks internal diagnostics when degraded', async () => {
  resetMock();
  const env = {
    GATEWAY_ACCESS_KEY_AIR: ACCESS_KEY,
    GATEWAY_ACCESS_MODELS_AIR: '*',
    TIER1_NODES_CONFIG_01: JSON.stringify([
      basicNode('good-1'),
      basicNode('good-2'),
      { ...basicNode('ghost'), id: 'ghost' },
    ]),
    TIER1_NODES_SECRETS_01: JSON.stringify({ 'good-1': 'k', 'good-2': 'k' }),
  };
  const res = await worker.fetch(new Request('https://gateway.example.com/', {
    headers: { accept: 'text/html' },
  }), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Smart AI Gateway/);
  assert.match(html, /一个入口，应对所有变化/);
  assert.match(html, /可用/);
  assert.ok(!html.includes('no credential found in TIER{N}_NODES_SECRETS_'));
  assert.ok(!html.includes('ghost'));
  assert.ok(!html.includes('2/3'));
  assert.ok(!html.includes('/health'));
  assert.ok(!html.includes(ACCESS_KEY));
});

await test('upstream 200 + JSON error body rotates to a healthy node', async () => {
  resetMock();
  routeHandlers['je-a.example.com'] = () => jsonUpstream({ error: { message: 'quota exceeded for this key', status: 429 } });
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
  assert.equal(s.totalFailures, 1);
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
  assert.ok(!text.includes('up-model'));
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
  assert.equal('health_score' in coldNode, false);
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
  assert.ok(!observedText.includes(sessionId));
  const observedNode = JSON.parse(observedText).endpoints.find((entry) => entry.id === 'diag');
  assert.equal(observedNode.runtime.models[0].state, 'observed_healthy');
  assert.equal(observedNode.runtime.models[0].sample_count, 1);
  assert.notEqual(observedNode.runtime.models[0].ttft_ewma_ms, null);
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
  const res = await worker.fetch(chatRequest({ model: 'm', messages: [] }), { GATEWAY_ACCESS_KEY_AIR: ACCESS_KEY, GATEWAY_ACCESS_MODELS_AIR: '*' }, {});
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error.message, /Model not found/);
  assert.equal(upstreamCalls.length, 0);
});

await test('public home renders when secrets are missing and leaks no internals', async () => {
  resetMock();
  const env = {
    GATEWAY_ACCESS_KEY_AIR: ACCESS_KEY,
    GATEWAY_ACCESS_MODELS_AIR: '*',
    TIER1_NODES_CONFIG_01: JSON.stringify([basicNode('half')]),
  };
  const res = await worker.fetch(new Request('https://gateway.example.com/', { headers: { accept: 'text/html' } }), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Smart AI Gateway/);
  assert.match(html, /OPENAI_BASE_URL/);
  assert.ok(!html.includes('TIER{N}_NODES_SECRETS_'));
  assert.ok(!html.includes('未绑定'));
  assert.ok(!html.includes('half'));
});

await test('public home renders on malformed config without leaking diagnostics', async () => {
  resetMock();
  const env = {
    GATEWAY_ACCESS_KEY_AIR: ACCESS_KEY,
    GATEWAY_ACCESS_MODELS_AIR: '*',
    TIER1_NODES_CONFIG_01: '{not-json',
    TIER1_NODES_SECRETS_01: '{"half":"k"}',
  };
  const res = await worker.fetch(new Request('https://gateway.example.com/', { headers: { accept: 'text/html' } }), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Smart AI Gateway/);
  assert.ok(!html.includes('valid JSON'));
  assert.ok(!html.includes('half'));
  assert.ok(!html.includes('已绑定'));
});

await test('public home shows degraded status when all serving nodes are cooling with recent evidence', async () => {
  resetMock();
  const env = makeEnv({
    tier1: [basicNode('de-a', { models: { air: 'up-air' } })],
    secrets: { 'de-a': 'k' },
    extraEnv: { MODELS_CONFIG: JSON.stringify({ air: { policy: 'fast' } }) },
  });
  const t1Model = getTier1Model('de-a', 'air');
  t1Model.cooldownUntil = Date.now() + 60_000;
  t1Model.failureState = 'cooldown';
  const d1 = createMockD1();
  env.TOKEN_STATS_DB = d1;
  await persistTokenUsage(env, { prompt_tokens: 10, completion_tokens: 5 }, Date.now(), 'air');
  const res = await worker.fetch(new Request('https://gateway.example.com/', { headers: { accept: 'text/html' } }), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes('general-air'));
  assert.match(html, /波动/);
  assert.ok(!html.includes('dot available'));
});

await test('public home shows down when all serving nodes are cooling and no recent evidence', async () => {
  resetMock();
  const env = makeEnv({
    tier1: [basicNode('de-b', { models: { air: 'up-air' } })],
    secrets: { 'de-b': 'k' },
    extraEnv: { MODELS_CONFIG: JSON.stringify({ air: { policy: 'fast' } }) },
  });
  const t1Model = getTier1Model('de-b', 'air');
  t1Model.cooldownUntil = Date.now() + 60_000;
  t1Model.failureState = 'cooldown';
  const res = await worker.fetch(new Request('https://gateway.example.com/', { headers: { accept: 'text/html' } }), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /故障/);
  assert.ok(!html.includes('dot available'));
});

await test('default success response does not leak node id / tier', async () => {
  resetMock();
  routeHandlers['leak.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({ tier1: [basicNode('leak')], secrets: { leak: 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-node'), null);
  assert.equal(res.headers.get('x-gateway-tier'), null);
  assert.ok(res.headers.get('x-request-id'));
});

await test('default exhausted response keeps attempt count but no node_id / per-attempt detail', async () => {
  resetMock();
  routeHandlers['ex1.example.com'] = () => jsonUpstream({}, 503);
  routeHandlers['ex2.example.com'] = () => jsonUpstream({}, 503);
  const env = makeEnv({ tier1: [basicNode('ex1'), basicNode('ex2')], secrets: { 'ex1': 'k', 'ex2': 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.details.attempts, 2);
  assert.equal(body.error.details.attempts_detail, undefined);
  assert.deepEqual(body.error.details.failure_kinds, { server: 2 });
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('node_id') && !serialized.includes('ex1') && !serialized.includes('ex2'));
});

await test('terminal status is driven by dominant failure kind, not the last attempt', async () => {
  resetMock();
  routeHandlers['tk1.example.com'] = () => jsonUpstream({}, 503);
  routeHandlers['tk2.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': '30' });
  const env1 = makeEnv({ tier1: [basicNode('tk1'), basicNode('tk2')], secrets: { tk1: 'k', tk2: 'k' } });
  const res1 = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env1, {});
  assert.equal(res1.status, 502);
  const b1 = await res1.json();
  assert.deepEqual(b1.error.details.failure_kinds, { server: 1, rate_limit: 1 });
  resetMock();
  routeHandlers['tk3.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': '20' });
  const env2 = makeEnv({ tier1: [basicNode('tk3')], secrets: { tk3: 'k' } });
  const res2 = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env2, {});
  assert.equal(res2.status, 429);
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
});

await test('failover budget caps a single attempt and stops before calling the next node', async () => {
  resetMock();
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
  assert.equal(res.status, 504);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['budget-a.example.com']);
  const body = await res.json();
  assert.equal(body.error.details.attempts, 1);
  assert.equal(res.headers.get('x-should-retry'), 'false');
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
  assert.ok(codeMax);
  assert.deepEqual(codeMax.api_backends.sort(), ['anthropic', 'mock']);
  assert.equal(codeMax.apiBackend, 'mixed');
  assert.equal(codeMax.supports_tools, true);
  assert.equal(codeMax.supports_vision, false);
  assert.deepEqual(codeMax.reasoning_efforts, ['high', 'low']);
});

await test('/health returns 503 for unconfigured/invalid config, 200 for degraded/ready', async () => {
  resetMock();
  const unconfigured = await worker.fetch(new Request('https://gateway.example.com/health', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), { GATEWAY_ACCESS_KEY_AIR: ACCESS_KEY, GATEWAY_ACCESS_MODELS_AIR: '*' }, {});
  assert.equal(unconfigured.status, 503);
  const ready = await worker.fetch(new Request('https://gateway.example.com/health', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), makeEnv({ tier1: [basicNode('h')], secrets: { h: 'k' } }), {});
  assert.equal(ready.status, 200);
});

await test('/version is public and exposes only branding, no node/config topology', async () => {
  resetMock();
  const res = await worker.fetch(new Request('https://gateway.example.com/version'), makeEnv({ tier1: [basicNode('v')], secrets: { v: 'k' } }), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  const pkgVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(body.name, 'ai-gateway');
  assert.equal(body.version, pkgVersion);
  assert.equal(body.runtime, 'Cloudflare Workers');
});

await test('/version exposes deployment identity as a `build` field (Build SHA = Deployment identity)', async () => {
  resetMock();
  const buildSha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
  const res = await worker.fetch(
    new Request('https://gateway.example.com/version'),
    makeEnv({ tier1: [basicNode('vid')], secrets: { vid: 'k' }, extraEnv: { GITHUB_SHA: buildSha } }),
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.build, buildSha);
});

await test('public home: brand & GitHub once, model status flat list, no protocol or version leak', async () => {
  resetMock();
  const env = makeEnv({
    tier1: [{ ...basicNode('g1'), models: { air: 'up-air', max: 'up-max', 'code-air': 'up-ca', 'code-max': 'up-cm' } }],
    secrets: { g1: 'k' },
  });
  const res = await worker.fetch(new Request('https://gateway.example.com/', { headers: { accept: 'text/html' } }), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.equal(html.split('<span class="brand-name">Smart AI Gateway</span>').length - 1, 1);
  assert.equal(html.split('github.com').length - 1, 1);
  assert.ok(html.indexOf('一个入口，应对所有变化') < html.indexOf('模型状态'));
  assert.ok(html.indexOf('模型状态') < html.indexOf('使用情况'));
  assert.ok(html.indexOf('使用情况') < html.indexOf('快速开始'));
});

await test('streaming relay delivers every chunk and terminates cleanly (torn [DONE], model rewrite)', async () => {
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
  assert.match(text, /\[DONE\]/);
  assert.ok(!text.includes('up-air'));
  assert.equal(getNodeState('sr').totalSuccesses, 1);
});

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
  assert.equal(sent.stream_options.other, 'kept');
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
  const failingD1 = { prepare: () => { throw new Error('D1 prepare exploded synchronously'); } };
  const env = makeEnv({
    tier1: [basicNode('d1ok')], secrets: { 'd1ok': 'k' },
    extraEnv: { TOKEN_STATS_DB: failingD1 },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
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
  assert.equal(row.requests, 1);
});

await test('a missing-usage request bumps requests + usage_missing in D1 (never estimated)', async () => {
  resetMock();
  routeHandlers['realm.example.com'] = () => jsonUpstream({
    id: 'chatcmpl-1', object: 'chat.completion', model: 'up-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  });
  const d1 = createMockD1();
  const env = makeEnv({
    tier1: [basicNode('realm')], secrets: { 'realm': 'k' },
    extraEnv: { TOKEN_STATS_DB: d1 },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  await res.text();
  const [row] = [...d1._rows.values()];
  assert.equal(row.total, 0);
  assert.equal(row.requests, 1);
  assert.equal(row.missing, 1);
});

await test('homepage with no D1 binding still serves and degrades the token panel', async () => {
  resetMock();
  const env = makeEnv({
    tier1: [basicNode('h1'), basicNode('h2')],
    secrets: { h1: 'k', h2: 'k' },
  });
  const res = await worker.fetch(new Request('https://gateway.example.com/', { headers: { accept: 'text/html' } }), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('使用情况'));
  assert.ok(html.includes('统计暂不可用'));
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
  recordTier1Ttft('lat-a', 'general-air', 3000);
  recordTier1Ttft('lat-b', 'general-air', 50);
  for (let i = 0; i < 3; i++) {
    const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
    assert.equal(res.status, 200);
    await streamText(res);
  }
  for (let i = 0; i < 12; i++) {
    recordTier1Ttft('lat-a', 'general-air', 10);
    recordTier1Ttft('lat-b', 'general-air', 2000);
  }
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  await streamText(res);
  assert.equal(upstreamCalls[3].host, 'lat-a.example.com');
});

await test('hedge: a slow primary is raced after HEDGE_DELAY_MS and the twin wins', async () => {
  resetMock();
  installMockFetch();
  const slow = async () => { await new Promise((r) => setTimeout(r, 3000)); return sseResponse([chunk('slow'), 'data: [DONE]']); };
  routeHandlers['hs-slow.example.com'] = slow;
  routeHandlers['hs-fast.example.com'] = () => sseResponse([chunk('fast'), 'data: [DONE]']);
  const env = makeEnvWithHedge({
    tier1: [basicNode('hs-slow'), basicNode('hs-fast')],
    secrets: { 'hs-slow': 'k', 'hs-fast': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '400', FAILOVER_BUDGET_MS: '30000' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  const text = await streamText(res);
  assert.ok(text.includes('fast'));
});

const hangUntilAbort = () => (req, url, init) => new Promise((resolve, reject) => {
  const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  if (init?.signal?.aborted) { reject(err); return; }
  init.signal.addEventListener('abort', () => reject(err), { once: true });
});

const stallSseUntilAbort = () => (req, url, init) => new Response(new ReadableStream({
  start(controller) {
    init.signal.addEventListener('abort', () => controller.error(new TypeError('aborted')), { once: true });
  },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });

await test('hedge: single candidate means no twin and normal behavior', async () => {
  resetMock();
  installMockFetch();
  const slow = async () => { await new Promise((r) => setTimeout(r, 700)); return sseResponse([chunk('solo'), 'data: [DONE]']); };
  routeHandlers['hs-solo.example.com'] = slow;
  const env = makeEnvWithHedge({
    tier1: [basicNode('hs-solo')],
    secrets: { 'hs-solo': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '200', FAILOVER_BUDGET_MS: '30000' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.ok((await streamText(res)).includes('solo'));
  assert.equal(upstreamCalls.length, 1);
});

await test('hedge: Tier 1 uses max_attempts logical attempts plus the bounded twin', async () => {
  resetMock();
  installMockFetch();
  const slowFailure = async () => { await new Promise((r) => setTimeout(r, 300)); return jsonUpstream({}, 500); };
  const ids = ['mf-p1', 'mf-t2', 'mf-p3', 'mf-p4', 'mf-p5', 'mf-p6'];
  for (const id of ids) routeHandlers[`${id}.example.com`] = slowFailure;
  const env = makeEnv({
    tier1: ids.map((id) => basicNode(id)),
    secrets: Object.fromEntries(ids.map((id) => [id, 'k'])),
    extraEnv: {
      HEDGE_DELAY_MS: '100',
      FAILOVER_BUDGET_MS: '60000',
      MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'fast' } }),
      POLICIES_CONFIG: JSON.stringify({ fast: { max_attempts: 5, hedge: { enabled: true, tiers: ['tier1'] } } }),
    },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.details.attempts, 5, 'global max_attempts remains the hard logical-attempt ceiling');
  assert.equal(body.error.details.dispatches, 6, 'five logical attempts plus one hedge twin');
  assert.equal(body.error.details.hedges, 1);
  assert.deepEqual(body.error.details.failure_kinds, { server: 6 });
  assert.equal(upstreamCalls.length, 6);
});

await test('hedge winner: primary aborted and recorded NEUTRAL (no failure, no penalty)', async () => {
  resetMock();
  installMockFetch();
  routeHandlers['hw-slow.example.com'] = hangUntilAbort();
  routeHandlers['hw-fast.example.com'] = () => sseResponse([chunk('fast'), 'data: [DONE]']);
  const env = makeEnvWithHedge({
    tier1: [basicNode('hw-slow'), basicNode('hw-fast')],
    secrets: { 'hw-slow': 'k', 'hw-fast': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '200', FAILOVER_BUDGET_MS: '30000' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.ok((await streamText(res)).includes('fast'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(getNodeState('hw-slow').totalFailures, 0);
});

await test('hedge winner at the first-event guard: primary loser stays neutral', async () => {
  resetMock();
  installMockFetch();
  routeHandlers['gl-stall.example.com'] = stallSseUntilAbort();
  routeHandlers['gl-fast.example.com'] = () => sseResponse([chunk('fast'), 'data: [DONE]']);
  const env = makeEnvWithHedge({
    tier1: [basicNode('gl-stall'), basicNode('gl-fast')],
    secrets: { 'gl-stall': 'k', 'gl-fast': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '200', FAILOVER_BUDGET_MS: '30000' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.ok((await streamText(res)).includes('fast'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(getNodeState('gl-stall').totalFailures, 0);
});

await test('hedge policy: tiers filter excludes tier-2 from hedging', async () => {
  resetMock();
  installMockFetch();
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
      POLICIES_CONFIG: JSON.stringify({ hp: { max_attempts: 5, hedge: { enabled: true, tiers: ['tier1'] } } }),
    },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.ok(!res.ok);
  const body = await res.json();
  assert.equal(body.error.details.hedges, 0);
  assert.equal(getNodeState('hp-t2b').totalRequests, 0);
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
  assert.equal(res.status, 499);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(getNodeState('ca-hang').totalFailures, 0);
});

if (!process.exitCode) console.log(`\nintegration tests passed (${passed}).`);
else process.exit(1);
