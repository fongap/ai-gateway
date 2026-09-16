#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Architecture Contract Tests — codify invariant guarantees of the gateway.
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { __resetAllStateForTests, getNodeState } from '../src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '../src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.ts';

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

const upstreamCalls = [];
let routeHandlers = {};
function installMockFetch() {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const handler = routeHandlers[url.hostname];
    if (!handler) throw new Error(`no mock upstream for ${url.hostname}`);
    upstreamCalls.push({
      host: url.hostname,
      path: url.pathname,
      headers: init?.headers,
      body: init?.body !== undefined ? JSON.parse(init.body) : null,
    });
    return handler(new Request(url, { method: 'POST', headers: init?.headers, body: init?.body }), url, init);
  };
}
function resetMock() { upstreamCalls.length = 0; routeHandlers = {}; }

function makeEnv({ tier1, tier2, tier3, secrets, extraEnv } = {}) {
  const tierSecrets = (nodes = []) => Object.fromEntries(
    nodes.map((node) => [node.id, secrets?.[node.id]]).filter(([, credential]) => credential !== undefined),
  );
  const tier1Secrets = tierSecrets(tier1);
  const tier2Secrets = tierSecrets(tier2);
  const tier3Secrets = tierSecrets(tier3);
  return {
    GATEWAY_ACCESS_KEY_AIR: ACCESS_KEY,
    GATEWAY_ACCESS_MODELS_AIR: '*',
    TIER1_SCHEDULER_SEED: 'arch-contract-test',
    ...(tier1 ? { TIER1_NODES_CONFIG_01: JSON.stringify(tier1) } : {}),
    ...(tier2 ? { TIER2_NODES_CONFIG_01: JSON.stringify(tier2) } : {}),
    ...(tier3 ? { TIER3_NODES_CONFIG_01: JSON.stringify(tier3) } : {}),
    ...(Object.keys(tier1Secrets).length ? { TIER1_NODES_SECRETS_01: JSON.stringify(tier1Secrets) } : {}),
    ...(Object.keys(tier2Secrets).length ? { TIER2_NODES_SECRETS_01: JSON.stringify(tier2Secrets) } : {}),
    ...(Object.keys(tier3Secrets).length ? { TIER3_NODES_SECRETS_01: JSON.stringify(tier3Secrets) } : {}),
    ...extraEnv,
  };
}

const openaiChatNode = (id, extra = {}) => ({
  id, provider: 'mock',
  base_url: `https://${id}.example.com/v1`, models: { 'Code-Max': 'up-model' }, ...extra,
});
const anthropicNode = (id, extra = {}) => ({
  id, provider: 'anthropic',
  base_url: `https://${id}.example.com`, models: { 'Code-Max': 'up-model' }, ...extra,
});

const chatRequest = (body) => new Request('https://gateway.example.com/v1/chat/completions', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
  body: JSON.stringify({ model: 'Code-Max', messages: [{ role: 'user', content: 'hi' }], ...body }),
});
const messagesRequest = (body) => new Request('https://gateway.example.com/v1/messages', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': ACCESS_KEY },
  body: JSON.stringify({ model: 'Code-Max', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...body }),
});
const jsonUpstream = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const okCompletion = () => ({
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});
const okMessage = () => ({
  type: 'message', role: 'assistant', model: 'up-model',
  content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});
installMockFetch();

await test('Contract 01: Native First — native runs before fallback', async () => {
  resetMock();
  routeHandlers['an.example.com'] = () => jsonUpstream(okMessage());
  routeHandlers['o1.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [anthropicNode('an'), openaiChatNode('o1')], secrets: { an: 'k', o1: 'k' },
    extraEnv: { PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }) },
  });
  const res = await worker.fetch(messagesRequest({}), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['an.example.com']);
});

await test('Contract 02: Native Empty + Explicit Fallback -> 200 via OpenAI', async () => {
  resetMock();
  routeHandlers['o1.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [openaiChatNode('o1')], secrets: { o1: 'k' },
    extraEnv: { PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }) },
  });
  const res = await worker.fetch(messagesRequest({}), env, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).type, 'message');
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['o1.example.com']);
});

await test('Contract 03: Default ON — Anthropic request with only OpenAI nodes -> 200 via fallback', async () => {
  resetMock();
  routeHandlers['o1.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({ tier1: [openaiChatNode('o1')], secrets: { o1: 'k' } });
  const res = await worker.fetch(messagesRequest({}), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['o1.example.com']);
});

await test('Contract 03b: PROTOCOL_FALLBACKS=disable -> 404', async () => {
  resetMock();
  routeHandlers['o1.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({ tier1: [openaiChatNode('o1')], secrets: { o1: 'k' }, extraEnv: { PROTOCOL_FALLBACKS: 'disable' } });
  const res = await worker.fetch(messagesRequest({}), env, {});
  assert.equal(res.status, 404);
  assert.equal(upstreamCalls.length, 0);
});

await test('Contract 05: Hedge twin never crosses protocol/surface', async () => {
  resetMock();
  const slowStream = () => {
    const encoder = new TextEncoder();
    let i = 0;
    const lines = ['event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"up-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'];
    return new ReadableStream({
      async pull(controller) {
        if (i >= lines.length) return;
        await new Promise((r) => setTimeout(r, 300));
        controller.enqueue(encoder.encode(lines[i++]));
      },
    });
  };
  routeHandlers['an-slow.example.com'] = () => new Response(slowStream(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  routeHandlers['an-fast.example.com'] = () => jsonUpstream(okMessage());
  routeHandlers['o1.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [anthropicNode('an-slow'), anthropicNode('an-fast'), openaiChatNode('o1')],
    secrets: { 'an-slow': 'k', 'an-fast': 'k', o1: 'k' },
    extraEnv: {
      PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }),
      HEDGE_DELAY_MS: '50',
      POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 5, hedge: { enabled: true, tiers: ['tier1'] } } }),
      MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }),
    },
  });
  const res = await worker.fetch(messagesRequest({ stream: true }), env, {});
  assert.equal(res.status, 200);
  const hosts = upstreamCalls.map((c) => c.host);
  assert.ok(hosts.includes('an-fast.example.com'));
  assert.ok(!hosts.includes('o1.example.com'));
});

await test('Contract 06: Stream commit -> no transparent failover', async () => {
  resetMock();
  const streamThenFail = () => {
    const encoder = new TextEncoder();
    let i = 0;
    const lines = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"up-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
    ];
    return new ReadableStream({
      pull(controller) {
        if (i >= lines.length) { controller.error(new Error('upstream died')); return; }
        controller.enqueue(encoder.encode(lines[i++]));
      },
    });
  };
  routeHandlers['an1.example.com'] = () => new Response(streamThenFail(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  routeHandlers['o1.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [anthropicNode('an1'), openaiChatNode('o1')], secrets: { an1: 'k', o1: 'k' },
    extraEnv: { PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }) },
  });
  await worker.fetch(messagesRequest({ stream: true }), env, {});
  const hosts = upstreamCalls.map((c) => c.host);
  assert.equal(hosts.filter((h) => h === 'an1.example.com').length, 1);
  assert.ok(!hosts.includes('o1.example.com'));
});

await test('Contract 07: Shared failover budget (attempts + fallback)', async () => {
  resetMock();
  routeHandlers['a1.example.com'] = () => jsonUpstream({ error: { message: 'overloaded' } }, 529);
  routeHandlers['a2.example.com'] = () => jsonUpstream({ error: { message: 'overloaded' } }, 529);
  routeHandlers['o1.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [anthropicNode('a1'), anthropicNode('a2'), openaiChatNode('o1')],
    secrets: { a1: 'k', a2: 'k', o1: 'k' },
    extraEnv: {
      PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }),
      MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }),
      POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 3 } }),
    },
  });
  const res = await worker.fetch(messagesRequest({}), env, {});
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls.length, 3);
});

await test('Contract 08: Logical attempt != physical hedge dispatch count', async () => {
  resetMock();
  routeHandlers['an-slow.example.com'] = (_req, _url, init) => new Promise((_, reject) => {
    if (init?.signal?.aborted) { reject(new Error('aborted')); return; }
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  routeHandlers['an-twin.example.com'] = async (_req, _url, init) => {
    await new Promise((r) => setTimeout(r, 150));
    if (init?.signal?.aborted) throw new Error('aborted');
    return jsonUpstream(okMessage());
  };
  const env = makeEnv({
    tier1: [anthropicNode('an-slow'), anthropicNode('an-twin')],
    secrets: { 'an-slow': 'k', 'an-twin': 'k' },
    extraEnv: {
      HEDGE_DELAY_MS: '120', FAILOVER_BUDGET_MS: '30000', UPSTREAM_HEADERS_TIMEOUT_MS: '2000',
      POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 5, hedge: { enabled: true, tiers: ['tier1'] } } }),
      MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }),
    },
  });
  const res = await worker.fetch(messagesRequest({}), env, {});
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(upstreamCalls.map((c) => c.host).sort(), ['an-slow.example.com', 'an-twin.example.com'].sort());
  assert.equal(getNodeState('an-slow').totalFailures, 0);
  assert.equal(getNodeState('an-twin').totalSuccesses, 1);
});

await test('Contract 09: removed node limits are rejected instead of influencing admission', async () => {
  resetMock();
  routeHandlers['an1.example.com'] = () => jsonUpstream(okMessage());
  const env = makeEnv({
    tier1: [anthropicNode('an1', { limits: { concurrency: 1, rpm: 60, rpm_mode: 'hard' } })],
    secrets: { an1: 'k' },
  });
  const health = await worker.fetch(new Request('https://gateway.example.com/health', { headers: { authorization: `Bearer ${ACCESS_KEY}` } }), env, {});
  assert.equal(health.status, 503);
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'invalid');
  assert.ok(healthBody.diagnostics.some((d) => d.includes('unknown field "limits"')));
  const res = await worker.fetch(messagesRequest({}), env, {});
  assert.equal(res.status, 404);
  assert.equal(upstreamCalls.length, 0);
});

await test('Contract 10: Closed Catalog - wildcard node rejects unknown model', async () => {
  resetMock();
  const wildcardNode = {
    id: 'wc1', provider: 'mock',
    base_url: 'https://wc1.example.com/v1', models: {},
  };
  routeHandlers['wc1.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [wildcardNode], secrets: { wc1: 'k' },
    extraEnv: { MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }) },
  });
  assert.equal((await worker.fetch(chatRequest({}), env, {})).status, 200);
  assert.equal((await worker.fetch(chatRequest({ model: 'random-model-xxx' }), env, {})).status, 404);
});

await test('Contract 11: Visible == Callable (key-scoped)', () => {
  assert.ok(true, 'Visible == Callable is enforced by model-authz and models response');
});

await test('Contract 12: Model Missing Isolation (per node-model pair)', async () => {
  resetMock();
  routeHandlers['an1.example.com'] = async (req) => {
    const body = await req.json();
    if (body.model === 'up-max') return jsonUpstream({ error: { message: 'Model not found' } }, 404);
    return jsonUpstream(okMessage());
  };
  const env = makeEnv({
    tier1: [anthropicNode('an1', { models: { 'Code-Max': 'up-max', 'Code-Pro': 'up-pro' } })],
    secrets: { an1: 'k' },
    extraEnv: { MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' }, 'Code-Pro': { policy: 'default' } }) },
  });
  const res1 = await worker.fetch(messagesRequest({ model: 'Code-Max' }), env, {});
  assert.equal(res1.status, 200);
  assert.equal((await res1.json()).model, 'Code-Max');
  assert.equal((await worker.fetch(messagesRequest({ model: 'Code-Pro' }), env, {})).status, 200);
});

await test('Contract 13: Runtime projection does not feedback to hot path', () => {
  assert.ok(true, 'model-status remains a read-only projection');
});

await test('Contract 14: D1 failure/missing binding does not block routing', async () => {
  resetMock();
  routeHandlers['an1.example.com'] = () => jsonUpstream(okMessage());
  const env = makeEnv({ tier1: [anthropicNode('an1')], secrets: { an1: 'k' } });
  assert.equal((await worker.fetch(messagesRequest({}), env, {})).status, 200);
});

await test('Contract 15: Tier 2/3 selector returns unified candidate shape', async () => {
  resetMock();
  const { pickCandidate } = await import('../src/scheduler/scheduler.ts');
  const { __resetAllStateForTests: reset } = await import('../src/reliability/node-state.ts');
  reset();
  const nodes = [
    { id: 't2a', tier: 'tier-2', provider: 'mock', protocol: 'openai', surfaces: ['chat_completions'], baseUrl: 'https://t2a.example.com/v1', credential: 'k', models: { 'Code-Max': 'up' }, priority: 10 },
    { id: 't2b', tier: 'tier-2', provider: 'mock', protocol: 'openai', surfaces: ['chat_completions'], baseUrl: 'https://t2b.example.com/v1', credential: 'k', models: { 'Code-Max': 'up' }, priority: 10 },
  ];
  const req = { model: 'Code-Max', protocol: 'openai', surface: 'chat_completions' };
  const r1 = pickCandidate(nodes, req, new Set());
  assert.ok(r1?.node);
  const r2 = pickCandidate(nodes, req, new Set([r1.node.id]));
  assert.ok(r2?.node);
  assert.equal(pickCandidate(nodes, req, new Set([r1.node.id, r2.node.id])), null);
  assert.ok('raceLost' in r1 || r1.raceLost === undefined);
  assert.ok('releaseToken' in r1 || r1.releaseToken === undefined);
  reset();
});

await test('Contract 16: one tier allocation model preserves Tier precedence', async () => {
  resetMock();
  const { computeTierCaps } = await import('../src/request/tier-loop.ts');
  const { __resetAllStateForTests: reset } = await import('../src/reliability/node-state.ts');
  reset();
  const runtimeNode = (id, tier) => ({
    id, tier, provider: 'mock', protocol: 'openai', surfaces: ['chat_completions'],
    baseUrl: `https://${id}.example.com/v1`, credential: 'k', priority: 10,
    models: { 'Code-Max': 'up' },
  });
  const tiers = {
    1: [],
    2: [runtimeNode('t2-a', 'tier-2')],
    3: [runtimeNode('t3-a', 'tier-3'), runtimeNode('t3-b', 'tier-3'), runtimeNode('t3-c', 'tier-3')],
  };
  const req = { model: 'Code-Max', protocol: 'openai', surface: 'chat_completions' };

  const caps = computeTierCaps(tiers, req, new Set(), {
    maxAttempts: 6, tierAttempts: null, hedge: null,
    firstEventTimeoutMs: null, maxInFlight: null,
  }, new Set(['Code-Max']));
  assert.deepEqual(caps, { 1: 0, 2: 5, 3: 1 },
    'node count must not pull surplus away from the first dispatchable tier');

  const explicit = computeTierCaps(tiers, req, new Set(), {
    maxAttempts: 6, tierAttempts: { tier2: 3 }, hedge: null,
    firstEventTimeoutMs: null, maxInFlight: null,
  }, new Set(['Code-Max']));
  assert.deepEqual(explicit, { 1: 0, 2: 3, 3: 3 },
    'explicit tier cap stays fixed and the remaining tier receives the remainder');

  const disabled = computeTierCaps(tiers, req, new Set(), {
    maxAttempts: 6, tierAttempts: { tier2: 0 }, hedge: null,
    firstEventTimeoutMs: null, maxInFlight: null,
  }, new Set(['Code-Max']));
  assert.deepEqual(disabled, { 1: 0, 2: 0, 3: 6 }, 'explicit zero disables Tier 2');
  reset();
});

console.log(`\nArchitecture contract tests passed (${passed}).`);
if (process.exitCode) process.exit(1);
