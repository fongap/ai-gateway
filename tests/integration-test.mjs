#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Black-box integration coverage for the current gateway architecture.
// Runs the real worker pipeline against mocked upstreams. Retired node limits
// stay rejected, while protocol/surface capabilities are derived from the Provider
// profile rather than repeated in account-level Node JSON.

import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { __resetAllStateForTests, getNodeState } from '../src/reliability/node-state.ts';
import {
  __resetTier1StateForTests,
  tier1AccountInFlight,
  getTier1Account,
  getTier1Model,
  recordTier1Ttft,
} from '../src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.ts';
import { __resetAdaptive429StateForTests } from '../src/reliability/adaptive-429.ts';

const ACCESS_KEY = 'test-access-key';
let passed = 0;

async function test(name, fn) {
  try {
    __resetAllStateForTests();
    __resetTier1StateForTests();
    __resetTier1AffinityForTests();
    __resetAdaptive429StateForTests();
    resetMock();
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

// ---- Mock upstream ---------------------------------------------------------

const upstreamCalls = [];
let routeHandlers = {};

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const handler = routeHandlers[url.hostname];
  if (!handler) throw new Error(`no mock upstream for ${url.hostname}`);
  const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers || {});
  const bodyText = init?.body == null ? null : String(init.body);
  upstreamCalls.push({
    host: url.hostname,
    path: url.pathname,
    url,
    headers,
    authorization: headers.get('authorization'),
    body: bodyText ? JSON.parse(bodyText) : null,
  });
  return handler(input, url, init);
};

function resetMock() {
  upstreamCalls.length = 0;
  routeHandlers = {};
}

function makeEnv({ tier1, tier2, tier3, secrets = {}, extraEnv = {} } = {}) {
  const secretSubset = (nodes = []) => Object.fromEntries(
    nodes.map((n) => [n.id, secrets[n.id]]).filter(([, value]) => value !== undefined),
  );
  const t1s = secretSubset(tier1);
  const t2s = secretSubset(tier2);
  const t3s = secretSubset(tier3);
  return {
    GATEWAY_ACCESS_KEY_AIR: ACCESS_KEY,
    GATEWAY_ACCESS_MODELS_AIR: '*',
    TIER1_SCHEDULER_SEED: 'integration-test',
    ...(tier1 ? { TIER1_NODES_CONFIG_01: JSON.stringify(tier1) } : {}),
    ...(tier2 ? { TIER2_NODES_CONFIG_01: JSON.stringify(tier2) } : {}),
    ...(tier3 ? { TIER3_NODES_CONFIG_01: JSON.stringify(tier3) } : {}),
    ...(Object.keys(t1s).length ? { TIER1_NODES_SECRETS_01: JSON.stringify(t1s) } : {}),
    ...(Object.keys(t2s).length ? { TIER2_NODES_SECRETS_01: JSON.stringify(t2s) } : {}),
    ...(Object.keys(t3s).length ? { TIER3_NODES_SECRETS_01: JSON.stringify(t3s) } : {}),
    ...extraEnv,
  };
}

const openaiNode = (id, extra = {}) => ({
  id,
  provider: 'mock',
  base_url: `https://${id}.example.com/v1`,
  models: { 'general-air': 'up-model' },
  ...extra,
});

const anthropicNode = (id, extra = {}) => ({
  id,
  provider: 'anthropic',
  base_url: `https://${id}.example.com`,
  models: { 'general-air': 'up-model' },
  ...extra,
});

const responsesNode = (id, extra = {}) => ({
  id,
  provider: 'openai',
  base_url: `https://${id}.example.com/v1`,
  models: { 'general-air': 'up-model' },
  ...extra,
});

function chatRequest(body = {}, key = ACCESS_KEY, init = {}) {
  return new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key !== null ? { authorization: `Bearer ${key}` } : {}),
      ...(init.headers || {}),
    },
    body: JSON.stringify({ model: 'general-air', messages: [], ...body }),
    signal: init.signal,
  });
}

function messagesRequest(body = {}, key = ACCESS_KEY) {
  return new Request('https://gateway.example.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'general-air', max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      ...body,
    }),
  });
}

function responsesRequest(body = {}) {
  return new Request('https://gateway.example.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify({ model: 'general-air', input: 'hi', ...body }),
  });
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const okChat = (content = 'hello', model = 'up-model') => ({
  id: 'chatcmpl-test', object: 'chat.completion', model,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

const okMessage = (text = 'hello', model = 'up-model') => ({
  id: 'msg_test', type: 'message', role: 'assistant', model,
  content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

const okResponses = (text = 'hello', model = 'up-model') => ({
  id: 'resp_test', object: 'response', status: 'completed', model,
  output: [{
    type: 'message', id: 'msg_test', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
});

const chatChunk = (delta, finishReason = null) => ({
  id: 'chatcmpl-test', object: 'chat.completion.chunk', model: 'up-model',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

function sseResponse(events) {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index >= events.length) { controller.close(); return; }
      const value = events[index++];
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      controller.enqueue(encoder.encode(`data: ${text}\n\n`));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function rawSseResponse(parts) {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index >= parts.length) { controller.close(); return; }
      controller.enqueue(encoder.encode(parts[index++]));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function hangUntilAbort() {
  return (_input, _url, init) => new Promise((_, reject) => {
    const error = Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (init?.signal?.aborted) { reject(error); return; }
    init?.signal?.addEventListener('abort', () => reject(error), { once: true });
  });
}

// ---- Strict configuration / auth ------------------------------------------

await test('missing gateway key returns 401 without upstream traffic', async () => {
  routeHandlers['auth.example.com'] = () => jsonResponse(okChat());
  const env = makeEnv({ tier1: [openaiNode('auth')], secrets: { auth: 'k' } });
  const res = await worker.fetch(chatRequest({}, null), env, {});
  assert.equal(res.status, 401);
  assert.equal(upstreamCalls.length, 0);
});

await test('wrong gateway key returns 401', async () => {
  const env = makeEnv({ tier1: [openaiNode('auth')], secrets: { auth: 'k' } });
  const res = await worker.fetch(chatRequest({}, 'wrong-key'), env, {});
  assert.equal(res.status, 401);
});

await test('removed limits field is a hard schema error and never reaches upstream', async () => {
  routeHandlers['old.example.com'] = () => jsonResponse(okChat());
  const env = makeEnv({
    tier1: [openaiNode('old', { limits: { concurrency: 1, rpm: 60 } })],
    secrets: { old: 'k' },
  });
  const health = await worker.fetch(new Request('https://gateway.example.com/health', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  assert.equal(health.status, 503);
  const hb = await health.json();
  assert.equal(hb.status, 'invalid');
  assert.ok(hb.diagnostics.some((d) => d.includes('unknown field "limits"')));
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 404);
  assert.equal(upstreamCalls.length, 0);
});

await test('protocol/surfaces in Node JSON are hard schema errors and never reach upstream', async () => {
  routeHandlers['retired-wire-fields.example.com'] = () => jsonResponse(okChat('must-not-route'));
  const invalid = {
    id: 'retired-wire-fields', provider: 'mock',
    protocol: 'openai', surfaces: ['chat_completions'],
    base_url: 'https://retired-wire-fields.example.com/v1',
    models: { 'general-air': 'up-model' },
  };
  const env = makeEnv({ tier1: [invalid], secrets: { 'retired-wire-fields': 'k' } });
  const health = await worker.fetch(new Request('https://gateway.example.com/health', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  assert.equal(health.status, 503);
  const body = await health.json();
  assert.equal(body.status, 'invalid');
  assert.ok(body.diagnostics.some((d) =>
    d.includes('unknown field "protocol"') || d.includes('unknown field "surfaces"')
  ));
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 404);
  assert.equal(upstreamCalls.length, 0);
});

// ---- Native routing / failover --------------------------------------------

await test('OpenAI Chat native success rewrites model identity and hides topology by default', async () => {
  routeHandlers['native.example.com'] = () => jsonResponse(okChat('native-ok'));
  const env = makeEnv({ tier1: [openaiNode('native')], secrets: { native: 'provider-key' } });
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model, 'general-air');
  assert.equal(body.choices[0].message.content, 'native-ok');
  assert.equal(upstreamCalls[0].path, '/v1/chat/completions');
  assert.equal(upstreamCalls[0].authorization, 'Bearer provider-key');
  assert.equal(upstreamCalls[0].body.model, 'up-model');
  assert.equal(res.headers.get('x-gateway-node'), null);
  assert.equal(res.headers.get('x-gateway-tier'), null);
});

await test('same-tier failover rotates from a transient failure to a healthy peer', async () => {
  routeHandlers['same-a.example.com'] = () => jsonResponse({}, 503);
  routeHandlers['same-b.example.com'] = () => jsonResponse(okChat('peer-ok'));
  recordTier1Ttft('same-a', 'general-air', 50);
  recordTier1Ttft('same-b', 'general-air', 2_000);
  const env = makeEnv({
    tier1: [openaiNode('same-a'), openaiNode('same-b')],
    secrets: { 'same-a': 'a', 'same-b': 'b' },
  });
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['same-a.example.com', 'same-b.example.com']);
});

await test('live in-flight load is soft: the sole healthy Tier 1 node accepts a second request', async () => {
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  routeHandlers['soft.example.com'] = async () => {
    calls++;
    if (calls === 1) await gate;
    return jsonResponse(okChat());
  };
  const env = makeEnv({ tier1: [openaiNode('soft')], secrets: { soft: 'k' } });
  const first = worker.fetch(chatRequest(), env, {});
  for (let i = 0; i < 100 && upstreamCalls.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(upstreamCalls.length, 1);
  assert.equal(tier1AccountInFlight('soft'), 1);
  const second = await worker.fetch(chatRequest(), env, {});
  assert.equal(second.status, 200);
  assert.equal(upstreamCalls.length, 2);
  releaseFirst();
  const firstRes = await first;
  assert.equal(firstRes.status, 200);
  await firstRes.text();
  assert.equal(tier1AccountInFlight('soft'), 0);
});

await test('legacy QUOTA_RATE_LIMITER binding is not provider admission policy', async () => {
  let limiterCalls = 0;
  const binding = { limit: async () => { limiterCalls++; return { success: false }; } };
  routeHandlers['quota.example.com'] = () => jsonResponse(okChat());
  const env = makeEnv({
    tier1: [openaiNode('quota')], secrets: { quota: 'k' },
    extraEnv: { QUOTA_RATE_LIMITER: binding },
  });
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 200);
  assert.equal(limiterCalls, 0);
  assert.equal(upstreamCalls.length, 1);
});

await test('Tier 1 -> Tier 2 -> Tier 3 fallback preserves strict tier order', async () => {
  routeHandlers['t1.example.com'] = () => jsonResponse({}, 503);
  routeHandlers['t2.example.com'] = () => jsonResponse({}, 503);
  routeHandlers['t3.example.com'] = () => jsonResponse(okChat('tier3-ok'));
  const env = makeEnv({
    tier1: [openaiNode('t1')], tier2: [openaiNode('t2')], tier3: [openaiNode('t3')],
    secrets: { t1: '1', t2: '2', t3: '3' },
  });
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['t1.example.com', 't2.example.com', 't3.example.com']);
});

await test('busy Tier 2 remains last-resort capacity when it is the only healthy fallback', async () => {
  let releaseParked;
  const gate = new Promise((resolve) => { releaseParked = resolve; });
  let t2Calls = 0;
  routeHandlers['busy-t2.example.com'] = async () => {
    t2Calls++;
    if (t2Calls === 1) await gate;
    return jsonResponse(okChat());
  };
  routeHandlers['busy-t1.example.com'] = () => jsonResponse({}, 503);
  const env = makeEnv({
    tier1: [openaiNode('busy-t1', { models: { 'general-air': 'up-a' } })],
    tier2: [openaiNode('busy-t2', { models: { 'general-air': 'up-a', parked: 'up-p' } })],
    secrets: { 'busy-t1': '1', 'busy-t2': '2' },
    extraEnv: {
      MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'fast' }, parked: { policy: 'fast' } }),
      POLICIES_CONFIG: JSON.stringify({ fast: { max_attempts: 2 } }),
    },
  });
  const parked = worker.fetch(chatRequest({ model: 'parked' }), env, {});
  for (let i = 0; i < 100 && t2Calls < 1; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(t2Calls, 1);
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 200);
  assert.equal(t2Calls, 2);
  releaseParked();
  const parkedRes = await parked;
  assert.equal(parkedRes.status, 200);
  await parkedRes.text();
});

// ---- Failure scoping -------------------------------------------------------

await test('429 cools one key and rotates to another same-tier key before lower tiers', async () => {
  routeHandlers['rl-a.example.com'] = () => jsonResponse({}, 429, { 'retry-after': '30' });
  routeHandlers['rl-b.example.com'] = () => jsonResponse(okChat('same-tier'));
  routeHandlers['rl-t2.example.com'] = () => jsonResponse(okChat('wrong-tier'));
  recordTier1Ttft('rl-a', 'general-air', 50);
  recordTier1Ttft('rl-b', 'general-air', 2_000);
  const env = makeEnv({
    tier1: [openaiNode('rl-a'), openaiNode('rl-b')], tier2: [openaiNode('rl-t2')],
    secrets: { 'rl-a': 'a', 'rl-b': 'b', 'rl-t2': '2' },
  });
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['rl-a.example.com', 'rl-b.example.com']);
  assert.ok(getTier1Account('rl-a').accountCooldownUntil > Date.now());
});

await test('all eligible keys cooling returns 429 with a real Retry-After', async () => {
  routeHandlers['cool.example.com'] = () => jsonResponse({}, 429, { 'retry-after': '30' });
  const env = makeEnv({ tier1: [openaiNode('cool')], secrets: { cool: 'k' } });
  const first = await worker.fetch(chatRequest(), env, {});
  assert.equal(first.status, 429);
  const calls = upstreamCalls.length;
  const second = await worker.fetch(chatRequest(), env, {});
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers.get('retry-after')) > 0);
  assert.equal(upstreamCalls.length, calls, 'cooling key is not redispatched immediately');
});

await test('model_missing 404 cools only that mapping; sibling model on same node remains healthy', async () => {
  routeHandlers['map.example.com'] = (_input, _url, init) => {
    const body = JSON.parse(String(init.body));
    if (body.model === 'up-code') return jsonResponse({ error: { message: 'model not found' } }, 404);
    return jsonResponse(okChat('sibling-ok', body.model));
  };
  const env = makeEnv({
    tier1: [openaiNode('map', { models: { 'code-pro': 'up-code', 'general-air': 'up-air' } })],
    secrets: { map: 'k' },
  });
  const first = await worker.fetch(chatRequest({ model: 'code-pro' }), env, {});
  assert.ok(first.status >= 400);
  assert.equal(getTier1Account('map').accountDisabled, false);
  assert.equal(getTier1Model('map', 'code-pro').cooldownUntil, 0);
  const sibling = await worker.fetch(chatRequest(), env, {});
  assert.equal(sibling.status, 200);
  assert.equal((await sibling.json()).choices[0].message.content, 'sibling-ok');
});

await test('client-class 400 stops immediately instead of rotating', async () => {
  routeHandlers['bad-a.example.com'] = () => jsonResponse({ error: { message: 'bad request' } }, 400);
  routeHandlers['bad-b.example.com'] = () => jsonResponse(okChat());
  recordTier1Ttft('bad-a', 'general-air', 50);
  recordTier1Ttft('bad-b', 'general-air', 2_000);
  const env = makeEnv({
    tier1: [openaiNode('bad-a'), openaiNode('bad-b')],
    secrets: { 'bad-a': 'a', 'bad-b': 'b' },
  });
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 400);
  assert.equal(upstreamCalls.length, 1);
});

await test('HTTP 200 with non-JSON garbage rotates and penalizes the bad node', async () => {
  routeHandlers['html-a.example.com'] = () => new Response('<html>proxy error</html>', {
    status: 200, headers: { 'content-type': 'text/html' },
  });
  routeHandlers['html-b.example.com'] = () => jsonResponse(okChat('healthy'));
  recordTier1Ttft('html-a', 'general-air', 50);
  recordTier1Ttft('html-b', 'general-air', 2_000);
  const env = makeEnv({
    tier1: [openaiNode('html-a'), openaiNode('html-b')],
    secrets: { 'html-a': 'a', 'html-b': 'b' },
  });
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['html-a.example.com', 'html-b.example.com']);
  assert.equal(getNodeState('html-a').totalFailures, 1);
});

await test('HTTP 200 JSON error envelope also rotates to healthy capacity', async () => {
  routeHandlers['jsonerr-a.example.com'] = () => jsonResponse({ error: { message: 'quota exceeded', status: 429 } });
  routeHandlers['jsonerr-b.example.com'] = () => jsonResponse(okChat('healthy'));
  recordTier1Ttft('jsonerr-a', 'general-air', 50);
  recordTier1Ttft('jsonerr-b', 'general-air', 2_000);
  const env = makeEnv({
    tier1: [openaiNode('jsonerr-a'), openaiNode('jsonerr-b')],
    secrets: { 'jsonerr-a': 'a', 'jsonerr-b': 'b' },
  });
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['jsonerr-a.example.com', 'jsonerr-b.example.com']);
});

// ---- Streaming commit boundary -------------------------------------------

await test('stream lifecycle/role-only output is not a commit; empty node can still fail over', async () => {
  routeHandlers['role-a.example.com'] = () => sseResponse([
    chatChunk({ role: 'assistant' }),
  ]);
  routeHandlers['role-b.example.com'] = () => sseResponse([
    chatChunk({ content: 'real output' }), chatChunk({}, 'stop'), '[DONE]',
  ]);
  recordTier1Ttft('role-a', 'general-air', 50);
  recordTier1Ttft('role-b', 'general-air', 2_000);
  const env = makeEnv({
    tier1: [openaiNode('role-a'), openaiNode('role-b')],
    secrets: { 'role-a': 'a', 'role-b': 'b' },
  });
  const res = await worker.fetch(chatRequest({ stream: true }), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /real output/);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['role-a.example.com', 'role-b.example.com']);
});

await test('after meaningful stream output commits, transparent replay is forbidden', async () => {
  const encoder = new TextEncoder();
  let step = 0;
  routeHandlers['commit-a.example.com'] = () => new Response(new ReadableStream({
    pull(controller) {
      if (step++ === 0) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chatChunk({ content: 'committed' }))}\n\n`));
      } else {
        controller.error(new Error('upstream died after commit'));
      }
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  routeHandlers['commit-b.example.com'] = () => sseResponse([
    chatChunk({ content: 'must-not-replay' }), chatChunk({}, 'stop'), '[DONE]',
  ]);
  recordTier1Ttft('commit-a', 'general-air', 50);
  recordTier1Ttft('commit-b', 'general-air', 2_000);
  const env = makeEnv({
    tier1: [openaiNode('commit-a'), openaiNode('commit-b')],
    secrets: { 'commit-a': 'a', 'commit-b': 'b' },
  });
  const res = await worker.fetch(chatRequest({ stream: true }), env, {});
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  for (;;) {
    try { if ((await reader.read()).done) break; } catch { break; }
  }
  assert.equal(upstreamCalls.some((c) => c.host === 'commit-b.example.com'), false);
});

await test('Tier 1 streaming slot stays claimed until stream completion and releases once', async () => {
  const encoder = new TextEncoder();
  let controller;
  routeHandlers['life.example.com'] = () => new Response(new ReadableStream({
    start(c) { controller = c; },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const env = makeEnv({ tier1: [openaiNode('life')], secrets: { life: 'k' } });
  const pending = worker.fetch(chatRequest({ stream: true }), env, {});
  for (let i = 0; i < 100 && !controller; i++) await new Promise((r) => setTimeout(r, 5));
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chatChunk({ content: 'first' }))}\n\n`));
  const res = await pending;
  assert.equal(tier1AccountInFlight('life'), 1);
  const reader = res.body.getReader();
  await reader.read();
  assert.equal(tier1AccountInFlight('life'), 1);
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chatChunk({}, 'stop'))}\n\ndata: [DONE]\n\n`));
  controller.close();
  while (!(await reader.read()).done) { /* drain */ }
  assert.equal(tier1AccountInFlight('life'), 0);
});

// ---- Protocol boundaries ---------------------------------------------------

await test('Anthropic Messages native non-stream request stays native', async () => {
  routeHandlers['anthropic.example.com'] = () => jsonResponse(okMessage('native-anthropic'));
  const env = makeEnv({ tier1: [anthropicNode('anthropic')], secrets: { anthropic: 'ak' } });
  const res = await worker.fetch(messagesRequest(), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'message');
  assert.equal(body.model, 'general-air');
  assert.equal(body.content[0].text, 'native-anthropic');
  assert.equal(upstreamCalls[0].path, '/v1/messages');
  assert.equal(upstreamCalls[0].headers.get('x-api-key'), 'ak');
  assert.equal(upstreamCalls[0].headers.get('authorization'), null);
});

await test('Anthropic streaming preserves native lifecycle and model identity', async () => {
  routeHandlers['anstream.example.com'] = () => rawSseResponse([
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'up-model', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello stream' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 2 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ]);
  const env = makeEnv({ tier1: [anthropicNode('anstream')], secrets: { anstream: 'ak' } });
  const res = await worker.fetch(messagesRequest({ stream: true }), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /hello stream/);
  assert.match(text, /event: message_stop/);
  assert.ok(!text.includes('up-model'));
  assert.match(text, /"model":"general-air"/);
});

await test('Anthropic client may fall back to OpenAI Chat through the bounded conversion path', async () => {
  routeHandlers['cross.example.com'] = () => jsonResponse(okChat('converted'));
  const env = makeEnv({ tier1: [openaiNode('cross')], secrets: { cross: 'ok' } });
  const res = await worker.fetch(messagesRequest(), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'message');
  assert.equal(body.model, 'general-air');
  assert.equal(body.content[0].text, 'converted');
  assert.equal(upstreamCalls[0].path, '/v1/chat/completions');
});

await test('OpenAI Responses uses the native OpenAI provider profile', async () => {
  routeHandlers['responses.example.com'] = () => jsonResponse(okResponses('responses-ok'));
  const env = makeEnv({ tier1: [responsesNode('responses')], secrets: { responses: 'rk' } });
  const res = await worker.fetch(responsesRequest(), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model, 'general-air');
  assert.equal(body.output[0].content[0].text, 'responses-ok');
  assert.equal(upstreamCalls[0].path, '/v1/responses');
});

await test('Responses route never falls back to a chat-only node', async () => {
  routeHandlers['chatonly.example.com'] = () => jsonResponse(okChat());
  const env = makeEnv({ tier1: [openaiNode('chatonly')], secrets: { chatonly: 'k' } });
  const res = await worker.fetch(responsesRequest(), env, {});
  assert.equal(res.status, 404);
  assert.equal(upstreamCalls.length, 0);
});

// ---- Hedge / wall-clock budget --------------------------------------------

await test('hedge races a slow Tier 1 primary with a same-surface twin', async () => {
  routeHandlers['hedge-slow.example.com'] = hangUntilAbort();
  routeHandlers['hedge-fast.example.com'] = () => jsonResponse(okChat('hedge-winner'));
  recordTier1Ttft('hedge-slow', 'general-air', 50);
  recordTier1Ttft('hedge-fast', 'general-air', 2_000);
  const env = makeEnv({
    tier1: [openaiNode('hedge-slow'), openaiNode('hedge-fast')],
    secrets: { 'hedge-slow': 's', 'hedge-fast': 'f' },
    extraEnv: {
      FAILOVER_BUDGET_MS: '30000',
      HEDGE_DELAY_MS: '100',
      MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'hp' } }),
      POLICIES_CONFIG: JSON.stringify({ hp: { max_attempts: 2, hedge: { enabled: true, delay_ms: 100, tiers: ['tier1'] } } }),
    },
  });
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices[0].message.content, 'hedge-winner');
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['hedge-slow.example.com', 'hedge-fast.example.com']);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(getNodeState('hedge-slow').totalFailures, 0, 'hedge loser stays neutral');
});

await test('failover wall-clock budget stops before dispatching a fresh node', async () => {
  routeHandlers['budget-a.example.com'] = async () => {
    await new Promise((r) => setTimeout(r, 1_500));
    return jsonResponse({}, 502);
  };
  routeHandlers['budget-b.example.com'] = () => jsonResponse(okChat());
  recordTier1Ttft('budget-a', 'general-air', 50);
  recordTier1Ttft('budget-b', 'general-air', 2_000);
  const env = makeEnv({
    tier1: [openaiNode('budget-a'), openaiNode('budget-b')],
    secrets: { 'budget-a': 'a', 'budget-b': 'b' },
    extraEnv: { FAILOVER_BUDGET_MS: '1200' },
  });
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 504);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['budget-a.example.com']);
});

// ---- Operational boundaries ----------------------------------------------
await test('upstream header allowlist drops client cookies/forwarding headers', async () => {
  routeHandlers['headers.example.com'] = () => jsonResponse(okChat());
  const env = makeEnv({ tier1: [openaiNode('headers')], secrets: { headers: 'provider-secret' } });
  const res = await worker.fetch(chatRequest({}, ACCESS_KEY, {
    headers: { cookie: 'session=secret', 'x-forwarded-for': '1.2.3.4' },
  }), env, {});
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls[0].headers.get('cookie'), null);
  assert.equal(upstreamCalls[0].headers.get('x-forwarded-for'), null);
  assert.equal(upstreamCalls[0].headers.get('authorization'), 'Bearer provider-secret');
});

await test('D1 write failure is observational and never breaks a successful AI response', async () => {
  routeHandlers['d1.example.com'] = () => jsonResponse(okChat());
  const failingD1 = { prepare() { throw new Error('D1 unavailable'); } };
  const env = makeEnv({
    tier1: [openaiNode('d1')], secrets: { d1: 'k' }, extraEnv: { TOKEN_STATS_DB: failingD1 },
  });
  const res = await worker.fetch(chatRequest(), env, { waitUntil() {} });
  assert.equal(res.status, 200);
});

await test('/health is 200 for ready strict config and exposes no credentials', async () => {
  const secret = 'never-expose-this-provider-secret';
  const env = makeEnv({ tier1: [openaiNode('health')], secrets: { health: secret } });
  const res = await worker.fetch(new Request('https://gateway.example.com/health', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(secret));
  assert.equal(JSON.parse(text).status, 'ready');
});

await test('/v1/models derives public models from actual strict node mappings', async () => {
  const env = makeEnv({
    tier1: [
      openaiNode('models-oa', { models: { 'general-air': 'oa-up' } }),
      anthropicNode('models-an', { models: { 'general-air': 'an-up' } }),
    ],
    secrets: { 'models-oa': 'a', 'models-an': 'b' },
  });
  const res = await worker.fetch(new Request('https://gateway.example.com/v1/models', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  const model = body.data.find((m) => m.id === 'general-air');
  assert.ok(model);
  assert.deepEqual(model.api_backends.sort(), ['anthropic', 'mock']);
});

await test('/health.build reports deployment commit and /version stays removed', async () => {
  const build = 'a1b2c3d4e5f6';
  const env = makeEnv({
    tier1: [openaiNode('identity')], secrets: { identity: 'k' }, extraEnv: { GITHUB_SHA: build },
  });
  const health = await worker.fetch(new Request('https://gateway.example.com/health', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.build, build);
  assert.equal(JSON.stringify(body).includes('identity.example.com'), false);

  const version = await worker.fetch(new Request('https://gateway.example.com/version', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  assert.equal(version.status, 404);
  assert.equal(upstreamCalls.length, 0);
});

if (!process.exitCode) console.log(`\nintegration tests passed (${passed}).`);
else process.exit(1);
