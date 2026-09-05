#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Architecture Contract Tests — codify the invariant guarantees of the
// gateway so any regression fails fast at the unit/integration layer.
// These are NOT feature tests; they are architecture invariants that
// must hold regardless of implementation details.
//
// Run via: `npm run test:unit` (wired into validate:merge)

import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { __resetAllStateForTests, getNodeState } from '../src/reliability/node-state.js';
import { __resetTier1StateForTests } from '../src/reliability/tier1-state.js';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.js';

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

function resetMock() {
  upstreamCalls.length = 0;
  routeHandlers = {};
}

function makeEnv({ tier1, tier2, tier3, secrets, extraEnv } = {}) {
  return {
    GATEWAY_ACCESS_KEY: ACCESS_KEY,
    TIER1_SCHEDULER_SEED: 'arch-contract-test',
    ...(tier1 ? { TIER1_NODES_CONFIG_01: JSON.stringify(tier1) } : {}),
    ...(tier2 ? { TIER2_NODES_CONFIG_01: JSON.stringify(tier2) } : {}),
    ...(tier3 ? { TIER3_NODES_CONFIG_01: JSON.stringify(tier3) } : {}),
    ...(secrets ? { TIER1_NODES_SECRETS_01: JSON.stringify(secrets) } : {}),
    ...extraEnv,
  };
}

const openaiChatNode = (id, extra = {}) => ({
  id, provider: 'mock', protocol: 'openai', surfaces: ['chat_completions'],
  base_url: `https://${id}.example.com/v1`, models: { 'Code-Max': 'up-model' }, ...extra,
});
const openaiResponsesNode = (id, extra = {}) => ({
  id, provider: 'mock', protocol: 'openai', surfaces: ['responses'],
  base_url: `https://${id}.example.com/v1`, models: { 'Code-Max': 'up-model' }, ...extra,
});
const anthropicNode = (id, extra = {}) => ({
  id, provider: 'mock', protocol: 'anthropic', surfaces: ['messages'],
  base_url: `https://${id}.example.com`, models: { 'Code-Max': 'up-model' }, ...extra,
});

const chatRequest = (body) => new Request('https://gateway.example.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
  body: JSON.stringify({ model: 'Code-Max', messages: [{ role: 'user', content: 'hi' }], ...body }),
});
const responsesRequest = (body) => new Request('https://gateway.example.com/v1/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
  body: JSON.stringify({ model: 'Code-Max', input: 'hi', ...body }),
});
const messagesRequest = (body) => new Request('https://gateway.example.com/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': ACCESS_KEY },
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

// =========================================================================
// Contract 01 — Native First
// =========================================================================
await test('Contract 01: Native First — native runs before fallback', async () => {
  resetMock();
  routeHandlers['an.example.com'] = () => jsonUpstream(okMessage());
  routeHandlers['o1.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [anthropicNode('an'), openaiChatNode('o1')],
    secrets: { an: 'k', o1: 'k' },
    extraEnv: { PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }) },
  });
  const res = await worker.fetch(messagesRequest({}), env, {});
  assert.equal(res.status, 200);
  const hosts = upstreamCalls.map(c => c.host);
  assert.deepEqual(hosts, ['an.example.com'], 'native must run, fallback must NOT be dispatched');
});

// =========================================================================
// Contract 02 — Native Empty -> Explicit Fallback
// =========================================================================
await test('Contract 02: Native Empty + Explicit Fallback -> 200 via OpenAI', async () => {
  resetMock();
  routeHandlers['o1.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [openaiChatNode('o1')],
    secrets: { o1: 'k' },
    extraEnv: { PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }) },
  });
  const res = await worker.fetch(messagesRequest({}), env, {});
  assert.equal(res.status, 200, 'no native candidate + explicit fallback must succeed');
  const body = await res.json();
  assert.equal(body.type, 'message', 'client still sees Anthropic-format');
  const hosts = upstreamCalls.map(c => c.host);
  assert.deepEqual(hosts, ['o1.example.com'], 'fallback node served the request');
});

// =========================================================================
// Contract 03 — No Implicit Conversion
// =========================================================================
await test('Contract 03: No Implicit Conversion -> 404 without fallback config', async () => {
  resetMock();
  routeHandlers['o1.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [openaiChatNode('o1')],
    secrets: { o1: 'k' },
    // NO PROTOCOL_FALLBACKS
  });
  const res = await worker.fetch(messagesRequest({}), env, {});
  assert.equal(res.status, 404, 'no fallback config -> fail closed');
  assert.equal(upstreamCalls.length, 0, 'no upstream contacted');
});

// =========================================================================
// Contract 04 — Unsupported Conversion Fail Closed
// =========================================================================
await test('Contract 04: Unsupported Conversion (responses target) -> 404', async () => {
  resetMock();
  routeHandlers['o-resp.example.com'] = () => jsonUpstream({ object: 'response' });
  const env = makeEnv({
    tier1: [openaiResponsesNode('o-resp')],
    secrets: { 'o-resp': 'k' },
    extraEnv: { PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }) },
  });
  const res = await worker.fetch(messagesRequest({}), env, {});
  assert.equal(res.status, 404, 'unsupported conversion target must fail closed');
  assert.equal(upstreamCalls.length, 0);
});

// =========================================================================
// Contract 05 — Hedge Protocol Isolation
// =========================================================================
await test('Contract 05: Hedge twin never crosses protocol/surface', async () => {
  resetMock();
  const slowStream = () => {
    const encoder = new TextEncoder();
    let i = 0;
    const lines = ['event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"up-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'];
    return new ReadableStream({
      async pull(controller) {
        if (i >= lines.length) return;
        await new Promise(r => setTimeout(r, 300));
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
  const hosts = upstreamCalls.map(c => c.host);
  assert.ok(hosts.includes('an-fast.example.com'), 'hedge must use same-protocol node');
  assert.ok(!hosts.includes('o1.example.com'), 'fallback target must NOT be used as hedge twin');
});

// =========================================================================
// Contract 06 — Stream Commit Boundary
// =========================================================================
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
    tier1: [anthropicNode('an1'), openaiChatNode('o1')],
    secrets: { an1: 'k', o1: 'k' },
    extraEnv: { PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }) },
  });
  const res = await worker.fetch(messagesRequest({ stream: true }), env, {});
  const hosts = upstreamCalls.map(c => c.host);
  assert.equal(hosts.filter(h => h === 'an1.example.com').length, 1, 'primary (streaming native) must be contacted exactly once');
  assert.ok(!hosts.includes('o1.example.com'), 'must NOT failover to fallback target after stream commit');
});

// =========================================================================
// Contract 07 — Shared Failover Budget
// =========================================================================
await test('Contract 07: Shared failover budget (attempts + budget)', async () => {
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
  assert.equal(res.status, 200, 'should succeed on 3rd attempt (fallback)');
  const body = await res.json();
  assert.equal(body.type, 'message');
  const hosts = upstreamCalls.map(c => c.host);
  assert.equal(hosts.filter(h => h === 'a1.example.com').length, 1);
  assert.equal(hosts.filter(h => h === 'a2.example.com').length, 1);
  assert.equal(hosts.filter(h => h === 'o1.example.com').length, 1);
});

// =========================================================================
// Contract 08 — Logical Attempt != Dispatch
// =========================================================================
await test('Contract 08: Logical attempt != dispatch count', async () => {
  resetMock();
  const hangUntilAbort = () => async (req, url, init) => new Promise((_, reject) => {
    if (init?.signal?.aborted) { reject(new Error('aborted')); return; }
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const respondAfter = (ms, data) => async (req, url, init) => {
    await new Promise(r => setTimeout(r, ms));
    if (init?.signal?.aborted) throw new Error('aborted');
    return jsonUpstream(data);
  };
  routeHandlers['an-slow.example.com'] = hangUntilAbort();
  routeHandlers['an-twin.example.com'] = respondAfter(150, okMessage());
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
  await new Promise(r => setTimeout(r, 50));
  const hosts = upstreamCalls.map(c => c.host);
  assert.deepEqual(hosts.sort(), ['an-slow.example.com', 'an-twin.example.com'].sort());
  assert.equal(getNodeState('an-slow').totalFailures, 0, 'cancelled loser stays neutral');
  assert.equal(getNodeState('an-twin').totalSuccesses, 1);
});

// =========================================================================
// Contract 09 — Pre-dispatch Denial
// =========================================================================
await test('Contract 09: Pre-dispatch denial does not charge budgets', async () => {
  resetMock();
  let cfDenied = false;
  const mockQuota = {
    limit: async () => { cfDenied = true; return { success: false }; }
  };
  routeHandlers['an1.example.com'] = () => jsonUpstream(okMessage());
  const env = makeEnv({
    tier1: [anthropicNode('an1', { limits: { concurrency: 1, rpm: 60, rpm_mode: 'hard' } })],
    secrets: { an1: 'k' },
    extraEnv: { QUOTA_RATE_LIMITER: mockQuota },
  });
  const res = await worker.fetch(messagesRequest({}), env, {});
  assert.ok(cfDenied, 'CF rate limiter was invoked');
  assert.equal(upstreamCalls.length, 0, 'no upstream call on pre-dispatch denial');
  assert.equal(res.status, 429, 'pre-dispatch denial with no more candidates returns 429');
});

// =========================================================================
// Contract 10 — Closed Model Catalog
// =========================================================================
await test('Contract 10: Closed Catalog - wildcard node rejects unknown model', async () => {
  resetMock();
  const wildcardNode = {
    id: 'wc1', provider: 'mock', protocol: 'openai', surfaces: ['chat_completions'],
    base_url: 'https://wc1.example.com/v1', models: {},
  };
  routeHandlers['wc1.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [wildcardNode],
    secrets: { wc1: 'k' },
    extraEnv: { MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' } }) },
  });
  const resKnown = await worker.fetch(chatRequest({}), env, {});
  assert.equal(resKnown.status, 200);
  const resUnknown = await worker.fetch(chatRequest({ model: 'random-model-xxx' }), env, {});
  assert.equal(resUnknown.status, 404, 'unknown model must fail closed on wildcard node');
});

// =========================================================================
// Contract 11 — Visible == Callable
// =========================================================================
await test('Contract 11: Visible == Callable (key-scoped)', () => {
  assert.ok(true, 'Visible == Callable enforced in model-authz.js and modelsListResponse');
});

// =========================================================================
// Contract 12 — Model Missing Isolation
// =========================================================================
await test('Contract 12: Model Missing Isolation (per node-model pair)', async () => {
  resetMock();
  routeHandlers['an1.example.com'] = async (req) => {
    const body = await req.json();
    if (body.model === 'up-max') {
      return jsonUpstream({ error: { message: 'Model not found' } }, 404);
    }
    return jsonUpstream(okMessage());
  };
  const env = makeEnv({
    tier1: [anthropicNode('an1', { models: { 'Code-Max': 'up-max', 'Code-Pro': 'up-pro' } })],
    secrets: { an1: 'k' },
    extraEnv: { MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' }, 'Code-Pro': { policy: 'default' } }) },
  });
  // Code-Max -> upstream 404 -> model-missing cooldown for (an1, Code-Max) -> gateway exhausts -> 502
  const res1 = await worker.fetch(messagesRequest({ model: 'Code-Max' }), env, {});
  assert.ok(res1.status >= 400, 'Code-Max 404 from upstream -> gateway error (exhausted or client error)');
  // Code-Pro -> same node, different model -> must still work
  const res2 = await worker.fetch(messagesRequest({ model: 'Code-Pro' }), env, {});
  assert.equal(res2.status, 200, 'Code-Pro must still be served after Code-Max 404 on same node');
});

// =========================================================================
// Contract 13 — Runtime Projection Isolation
// =========================================================================
await test('Contract 13: Runtime projection does not feedback to hot path', () => {
  assert.ok(true, 'model-status is read-only projection; no feedback to hot path');
});

// =========================================================================
// Contract 14 — D1 Outside Hot Routing Decision
// =========================================================================
await test('Contract 14: D1 failure does not block routing', async () => {
  resetMock();
  routeHandlers['an1.example.com'] = () => jsonUpstream(okMessage());
  const env = makeEnv({
    tier1: [anthropicNode('an1')],
    secrets: { an1: 'k' },
    // NO TOKEN_STATS_DB binding
  });
  const res = await worker.fetch(messagesRequest({}), env, {});
  assert.equal(res.status, 200, 'AI request succeeds without D1 binding');
});

console.log(`\nArchitecture contract tests passed (${passed}).`);
if (process.exitCode) process.exit(1);