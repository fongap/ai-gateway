#!/usr/bin/env node
// Protocol matrix tests â€?the cross-protocol guarantees of the gateway.
//
// The gateway natively speaks exactly TWO protocol families:
//   openai    -> /v1/chat/completions (chat_completions), /v1/responses (responses)
//   anthropic -> /v1/messages (messages)
//
// These tests pin the routing matrix:
//   1. each client surface reaches only nodes of the SAME protocol + surface;
//   2. failover NEVER crosses the protocol or surface boundary;
//   3. hedge twins are always same-protocol and same-surface;
//   4. legacy node configs (no protocol/surfaces) still work via the
//      deprecated openai/chat_completions defaults.
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { __resetAllStateForTests, getNodeState } from '../src/reliability/node-state.js';

const ACCESS_KEY = 'test-access-key';

let passed = 0;
async function test(name, fn) {
  try {
    __resetAllStateForTests();
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

function makeEnv({ tier1, tier2, secrets, extraEnv } = {}) {
  return {
    GATEWAY_ACCESS_KEY: ACCESS_KEY,
    ...(tier1 ? { TIER1_NODES_CONFIG_01: JSON.stringify(tier1) } : {}),
    ...(tier2 ? { TIER2_NODES_CONFIG_01: JSON.stringify(tier2) } : {}),
    ...(secrets ? { NODE_SECRETS_01: JSON.stringify(secrets) } : {}),
    ...extraEnv,
  };
}

const openaiChatNode = (id, extra = {}) => ({
  id, provider: 'mock', protocol: 'openai', surfaces: ['chat_completions'],
  base_url: `https://${id}.example.com/v1`, models: { 'max': 'up-model' }, ...extra,
});
const openaiResponsesNode = (id, extra = {}) => ({
  id, provider: 'mock', protocol: 'openai', surfaces: ['responses'],
  base_url: `https://${id}.example.com/v1`, models: { 'max': 'up-model' }, ...extra,
});
const anthropicNode = (id, extra = {}) => ({
  id, provider: 'mock', protocol: 'anthropic', surfaces: ['messages'],
  base_url: `https://${id}.example.com`, models: { 'max': 'up-model' }, ...extra,
});

const chatRequest = (body) => new Request('https://gateway.example.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
  body: JSON.stringify({ model: 'max', messages: [{ role: 'user', content: 'hi' }], ...body }),
});
const responsesRequest = (body) => new Request('https://gateway.example.com/v1/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
  body: JSON.stringify({ model: 'max', input: 'hi', ...body }),
});
const messagesRequest = (body) => new Request('https://gateway.example.com/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': ACCESS_KEY },
  body: JSON.stringify({ model: 'max', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], ...body }),
});

const jsonUpstream = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

// A mock upstream that never answers on its own but honors the dispatch
// AbortController â€?like a real fetch hanging until the gateway aborts it.
const hangUntilAbort = () => async (req, url, init) => new Promise((_, reject) => {
  if (init?.signal?.aborted) { reject(new Error('aborted')); return; }
  init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});

function sseResponse(lines, headers = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (i >= lines.length) { controller.close(); return; }
      controller.enqueue(encoder.encode(lines[i++]));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}
const ev = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

// OpenAI chat wire shapes.
const chatChunk = (content) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
const chatFinish = 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n';
const chatDone = 'data: [DONE]\n\n';
const okCompletion = () => ({
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});
// Anthropic wire shapes.
const okMessage = () => ({
  type: 'message', role: 'assistant', model: 'up-model',
  content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});
const anthropicLifecycle = (text) => [
  ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'up-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }),
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 1 } }),
  ev('message_stop', { type: 'message_stop' }),
];
// Responses wire shapes.
const okResponsesObject = () => ({
  id: 'resp_1', object: 'response', created_at: 1, status: 'completed', model: 'up-model',
  output: [{ id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
});
const responsesLifecycle = (text) => {
  const item = { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
  return [
    ev('response.created', { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', object: 'response', status: 'in_progress', model: 'up-model', output: [], usage: {} } }),
    ev('response.output_item.added', { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, status: 'in_progress', content: [] } }),
    ev('response.output_text.delta', { type: 'response.output_text.delta', sequence_number: 2, item_id: 'msg_1', output_index: 0, content_index: 0, delta: text }),
    ev('response.output_item.done', { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item }),
    ev('response.completed', { type: 'response.completed', sequence_number: 4, response: { id: 'resp_1', object: 'response', status: 'completed', model: 'up-model', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
  ];
};

installMockFetch();

// ---- OpenAI Chat matrix ------------------------------------------------------

await test('OpenAI Chat client -> OpenAI chat node -> native success', async () => {
  resetMock();
  routeHandlers['oc.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({ tier1: [openaiChatNode('oc')], secrets: { oc: 'k' } });
  const res = await worker.fetch(chatRequest({}), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.content, 'hello');
  assert.equal(upstreamCalls[0].path, '/v1/chat/completions');
  assert.equal(upstreamCalls[0].body.model, 'up-model');
});

await test('OpenAI Chat: node A fails -> node B (same protocol+surface) fails over -> success', async () => {
  resetMock();
  routeHandlers['oc-a.example.com'] = () => jsonUpstream({}, 500);
  routeHandlers['oc-b.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({ tier1: [openaiChatNode('oc-a'), openaiChatNode('oc-b')], secrets: { 'oc-a': 'k', 'oc-b': 'k' } });
  const res = await worker.fetch(chatRequest({}), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['oc-a.example.com', 'oc-b.example.com']);
});

await test('OpenAI Chat: hedge twin wins, primary is neutral-cancelled', async () => {
  resetMock();
  // Primary hangs forever; the twin answers fast.
  routeHandlers['oc-hang.example.com'] = hangUntilAbort();
  routeHandlers['oc-twin.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [openaiChatNode('oc-hang'), openaiChatNode('oc-twin')],
    secrets: { 'oc-hang': 'k', 'oc-twin': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '120', FAILOVER_BUDGET_MS: '30000' },
  });
  const res = await worker.fetch(chatRequest({}), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['oc-hang.example.com', 'oc-twin.example.com']);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(getNodeState('oc-hang').totalFailures, 0, 'the cancelled loser stays neutral');
  assert.equal(getNodeState('oc-twin').totalSuccesses, 1, 'the twin wins and records success');
});

// ---- OpenAI Responses native -------------------------------------------------

await test('OpenAI Responses client -> responses-capable node -> native /v1/responses', async () => {
  resetMock();
  routeHandlers['orn.example.com'] = () => jsonUpstream(okResponsesObject());
  const env = makeEnv({ tier1: [openaiResponsesNode('orn')], secrets: { orn: 'k' } });
  const res = await worker.fetch(responsesRequest({}), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, 'response');
  assert.equal(body.model, 'max');
  assert.equal(upstreamCalls[0].path, '/v1/responses', 'the upstream path is the NATIVE responses endpoint');
  assert.equal(upstreamCalls[0].body.model, 'up-model');
  assert.equal(upstreamCalls[0].body.input, 'hi', 'the Responses body is forwarded verbatim');
});

await test('OpenAI Responses client is NEVER routed to a chat-only node', async () => {
  resetMock();
  routeHandlers['chatonly.example.com'] = () => jsonUpstream(okCompletion());
  routeHandlers['resp.example.com'] = () => sseResponse(responsesLifecycle('native'));
  const env = makeEnv({
    tier1: [openaiChatNode('chatonly'), openaiResponsesNode('resp')],
    secrets: { chatonly: 'k', resp: 'k' },
  });
  const res = await worker.fetch(responsesRequest({ stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['resp.example.com'],
    'a chat_completions-only node must never receive a /v1/responses request');
  const text = await res.text();
  assert.match(text, /response\.completed/);
});

await test('OpenAI Chat client is NEVER routed to a responses-only node', async () => {
  resetMock();
  routeHandlers['resp2.example.com'] = () => jsonUpstream(okResponsesObject());
  routeHandlers['chat2.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [openaiResponsesNode('resp2'), openaiChatNode('chat2')],
    secrets: { resp2: 'k', chat2: 'k' },
  });
  const res = await worker.fetch(chatRequest({}), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['chat2.example.com'],
    'a responses-only node must never receive a /v1/chat/completions request');
});

// ---- Anthropic native --------------------------------------------------------

await test('Anthropic client -> anthropic node -> native /v1/messages with x-api-key', async () => {
  resetMock();
  routeHandlers['an.example.com'] = () => jsonUpstream(okMessage());
  const env = makeEnv({ tier1: [anthropicNode('an')], secrets: { an: 'k' } });
  const res = await worker.fetch(messagesRequest({}), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'message');
  assert.equal(body.model, 'max');
  assert.equal(upstreamCalls[0].path, '/v1/messages');
  assert.equal(upstreamCalls[0].headers.get('x-api-key'), 'k', 'anthropic nodes authenticate via x-api-key');
  assert.equal(upstreamCalls[0].headers.get('authorization'), null, 'no Bearer header ever reaches an anthropic node');
  assert.ok(upstreamCalls[0].headers.get('anthropic-version'));
  assert.equal(upstreamCalls[0].body.model, 'up-model');
});

await test('Anthropic streaming passes the native lifecycle through', async () => {
  resetMock();
  routeHandlers['ans.example.com'] = () => sseResponse(anthropicLifecycle('native stream'));
  const env = makeEnv({ tier1: [anthropicNode('ans')], secrets: { ans: 'k' } });
  const res = await worker.fetch(messagesRequest({ stream: true }), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /message_start/);
  assert.match(text, /"type":"text_delta","text":"native stream"/);
  assert.ok(text.trimEnd().endsWith('data: {"type":"message_stop"}'));
  assert.equal(getNodeState('ans').totalSuccesses, 1);
});

// ---- Cross-protocol isolation (HARD boundary) --------------------------------

await test('OpenAI Chat fails on all openai nodes: the healthy anthropic node is NEVER contacted', async () => {
  resetMock();
  routeHandlers['xa.example.com'] = () => jsonUpstream({}, 500);
  routeHandlers['xb.example.com'] = () => jsonUpstream({}, 500);
  routeHandlers['healthy-an.example.com'] = () => jsonUpstream(okMessage());
  const env = makeEnv({
    tier1: [openaiChatNode('xa'), openaiChatNode('xb'), anthropicNode('healthy-an')],
    secrets: { xa: 'k', xb: 'k', 'healthy-an': 'k' },
  });
  const res = await worker.fetch(chatRequest({}), env, {});
  assert.equal(res.status, 502, 'all openai nodes failed -> terminal 502');
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['xa.example.com', 'xb.example.com'],
    'failover must stay inside the openai protocol; the anthropic node must never be contacted');
});

await test('Anthropic fails on the anthropic node: the healthy openai node is NEVER contacted', async () => {
  resetMock();
  routeHandlers['an5xx.example.com'] = () => jsonUpstream({ type: 'error', error: { type: 'api_error', message: 'boom' } }, 500);
  routeHandlers['healthy-oc.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [anthropicNode('an5xx'), openaiChatNode('healthy-oc')],
    secrets: { an5xx: 'k', 'healthy-oc': 'k' },
  });
  const res = await worker.fetch(messagesRequest({}), env, {});
  assert.equal(res.status, 502);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['an5xx.example.com'],
    'failover must stay inside the anthropic protocol');
  const body = await res.json();
  assert.equal(body.type, 'error', 'the client still receives an Anthropic-shaped error');
});

await test('in-tier failover: openai chat node A -> openai chat node B -> openai responses-only node is excluded', async () => {
  resetMock();
  routeHandlers['fa.example.com'] = () => jsonUpstream({}, 503);
  routeHandlers['fb.example.com'] = () => jsonUpstream(okCompletion());
  routeHandlers['fresp.example.com'] = () => jsonUpstream(okResponsesObject());
  const env = makeEnv({
    tier1: [openaiChatNode('fa'), openaiChatNode('fb'), openaiResponsesNode('fresp')],
    secrets: { fa: 'k', fb: 'k', fresp: 'k' },
  });
  const res = await worker.fetch(chatRequest({}), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['fa.example.com', 'fb.example.com'],
    'same-protocol same-surface failover works; the responses-only node stays excluded');
});

// ---- Hedge protocol/surface isolation ----------------------------------------

await test('hedge twin is same-protocol same-surface: no eligible twin -> no hedge', async () => {
  resetMock();
  // The only other candidate is an anthropic node; the primary hangs. No twin
  // may be launched against a different protocol â€?the request waits on the
  // primary (and eventually hits the failover budget).
  routeHandlers['hp.example.com'] = hangUntilAbort();
  routeHandlers['h-an.example.com'] = () => jsonUpstream(okMessage());
  const env = makeEnv({
    tier1: [openaiChatNode('hp'), anthropicNode('h-an')],
    secrets: { hp: 'k', 'h-an': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '120', FAILOVER_BUDGET_MS: '1500', UPSTREAM_HEADERS_TIMEOUT_MS: '2000' },
  });
  const res = await worker.fetch(chatRequest({}), env, {});
  assert.equal(res.status, 504, 'budget exhausted without an eligible twin');
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['hp.example.com'],
    'only the primary was contacted; the anthropic node was never used as a twin');
});

await test('hedge twin picks the same-surface node: responses-only nodes are excluded', async () => {
  resetMock();
  routeHandlers['hp2.example.com'] = hangUntilAbort();
  routeHandlers['h-resp.example.com'] = () => jsonUpstream(okResponsesObject());
  routeHandlers['h-twin.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [openaiChatNode('hp2'), openaiResponsesNode('h-resp'), openaiChatNode('h-twin')],
    secrets: { hp2: 'k', 'h-resp': 'k', 'h-twin': 'k' },
    extraEnv: { HEDGE_DELAY_MS: '120', FAILOVER_BUDGET_MS: '30000' },
  });
  const res = await worker.fetch(chatRequest({}), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['hp2.example.com', 'h-twin.example.com'],
    'the twin must be the chat_completions node, never the responses-only node');
  assert.equal(getNodeState('h-twin').totalSuccesses, 1);
});

// ---- Legacy config migration (end to end) ------------------------------------

await test('legacy node config (no protocol/surfaces) still serves chat with deprecated defaults', async () => {
  resetMock();
  routeHandlers['legacy.example.com'] = () => jsonUpstream(okCompletion());
  const legacyNode = { id: 'legacy-01', provider: 'nvidia', base_url: 'https://legacy.example.com/v1', priority: 10, models: { max: 'up-model' } };
  const env = makeEnv({ tier1: [legacyNode], secrets: { 'legacy-01': 'k' } });
  // The deprecation diagnostics must be visible via /health without making
  // the config invalid.
  const health = await worker.fetch(new Request('https://gateway.example.com/health', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  assert.equal(health.status, 200, 'legacy config must NOT invalidate the gateway');
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'ready');
  assert.ok(healthBody.diagnostics.some((d) => d.includes('legacy-01') && d.includes('protocol is implicit')),
    `expected the protocol deprecation diagnostic, got ${JSON.stringify(healthBody.diagnostics)}`);
  assert.ok(healthBody.diagnostics.some((d) => d.includes('legacy-01') && d.includes('surfaces is implicit')),
    `expected the surfaces deprecation diagnostic, got ${JSON.stringify(healthBody.diagnostics)}`);
  // ...and the node must actually serve OpenAI Chat traffic.
  const res = await worker.fetch(chatRequest({}), env, {});
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls[0].path, '/v1/chat/completions');
  assert.deepEqual(healthBody.nodes_protocol, undefined, 'no topology leak beyond the documented fields');
});

await test('legacy anthropic-labeled node defaults to openai protocol (explicit migration path exists)', async () => {
  resetMock();
  // A pre-protocol node labeled "anthropic" still maps to the openai chat
  // transport (that is what the gateway actually did before the protocol
  // field existed). Native anthropic service requires the explicit upgrade.
  routeHandlers['old-an.example.com'] = () => jsonUpstream(okCompletion());
  const legacyNode = { id: 'old-an', provider: 'anthropic', base_url: 'https://old-an.example.com/v1', models: { max: 'up-model' } };
  const env = makeEnv({ tier1: [legacyNode], secrets: { 'old-an': 'k' } });
  const res = await worker.fetch(chatRequest({}), env, {});
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls[0].path, '/v1/chat/completions');
  // A /v1/messages request can NOT be served by this legacy node â€?the
  // operator must explicitly declare protocol=anthropic to unlock it.
  resetMock();
  const messagesRes = await worker.fetch(messagesRequest({}), env, {});
  assert.equal(messagesRes.status, 404,
    'implicit-default openai nodes must not silently serve the anthropic surface');
});

await test('explicit protocol=anthropic node unlocks the native messages surface', async () => {
  resetMock();
  routeHandlers['mig-an.example.com'] = () => sseResponse(anthropicLifecycle('migrated'));
  const env = makeEnv({ tier1: [anthropicNode('mig-an')], secrets: { 'mig-an': 'k' } });
  const res = await worker.fetch(messagesRequest({ stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls[0].path, '/v1/messages');
  const text = await res.text();
  assert.match(text, /migrated/);
});

if (!process.exitCode) console.log(`\nprotocol matrix tests passed (${passed}).`);
else process.exit(1);
