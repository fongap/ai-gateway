#!/usr/bin/env node
// Claude Code / Anthropic Messages contract tests.
//
// Black-box: run the REAL worker pipeline (auth -> scheduler -> retry ->
// circuit -> transport -> stream) through worker.fetch() against a mocked
// global fetch upstream, exactly as a Claude Code client drives /v1/messages.
// These tests pin the customer-facing protocol contract (text, stream,
// thinking, tool_use, tool_result, error shapes), not internal structure.
//
// The Anthropic path is NATIVE end to end: the gateway forwards the request
// body verbatim (model substituted) to the upstream /v1/messages endpoint and
// relays the upstream's native Anthropic SSE lifecycle. Every mock upstream
// below therefore speaks the Anthropic wire format.
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { __resetAllStateForTests, getNodeState } from '../src/reliability/node-state.js';
import { __resetTier1StateForTests, recordTier1Ttft } from '../src/reliability/tier1-state.js';
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
    const req = init?.body !== undefined
      ? new Request(url, { method: 'POST', headers: init.headers, body: init.body })
      : null;
    if (req) upstreamCalls.push({ host: url.hostname, url, body: JSON.parse(init.body), headers: init.headers });
    else upstreamCalls.push({ host: url.hostname, url, body: null, headers: init.headers });
    return handler(req ?? {}, url);
  };
}

function resetMock() {
  upstreamCalls.length = 0;
  routeHandlers = {};
}

function makeEnv({ tier1, tier2, secrets, extraEnv } = {}) {
  return {
    GATEWAY_ACCESS_KEY: ACCESS_KEY,
    TIER1_SCHEDULER_SEED: 'claude-contract-test',
    ...(tier1 ? { TIER1_NODES_CONFIG_01: JSON.stringify(tier1) } : {}),
    ...(tier2 ? { TIER2_NODES_CONFIG_01: JSON.stringify(tier2) } : {}),
    ...(secrets ? { TIER1_NODES_SECRETS_01: JSON.stringify(secrets) } : {}),
    ...extraEnv,
  };
}

// Anthropic-protocol node serving /v1/messages natively.
const node = (id, extra = {}) => ({
  id,
  provider: 'mock',
  protocol: 'anthropic',
  surfaces: ['messages'],
  base_url: `https://${id}.example.com`,
  models: { 'claude-x': 'up-model' },
  ...extra,
});

function messagesRequest(body, opts = {}) {
  return new Request('https://gateway.example.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.key === undefined ? ACCESS_KEY : opts.key,
      ...(opts.headers || {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function jsonUpstream(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

// Native Anthropic SSE helpers: named events, `data:` JSON payloads.
function sseBody(lines) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= lines.length) { controller.close(); return; }
      controller.enqueue(encoder.encode(lines[i++]));
    },
  });
}
function sseResponse(lines, headers = {}) {
  return new Response(sseBody(lines), { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

const messageStart = () => event('message_start', {
  type: 'message_start',
  message: {
    id: 'msg_up1', type: 'message', role: 'assistant', model: 'up-model',
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 0 },
  },
});
const blockStart = (index, block) => event('content_block_start', { type: 'content_block_start', index, content_block: block });
const textDelta = (index, text) => event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const thinkingDelta = (index, text) => event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } });
const inputJsonDelta = (index, json) => event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } });
const signatureDelta = (index, signature) => event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } });
const blockStop = (index) => event('content_block_stop', { type: 'content_block_stop', index });
const messageDelta = (stopReason = 'end_turn', usage = { input_tokens: 1, output_tokens: 1 }) => event('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage });
const messageStop = () => event('message_stop', { type: 'message_stop' });

// A complete native text lifecycle.
const textLifecycle = (text) => [
  messageStart(),
  blockStart(0, { type: 'text', text: '' }),
  textDelta(0, text),
  blockStop(0),
  messageDelta(),
  messageStop(),
];

// A complete native non-stream message.
const okMessage = (over = {}) => ({
  id: 'msg_up1',
  type: 'message',
  role: 'assistant',
  model: 'up-model',
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
  ...over,
});

installMockFetch();

// ---- text / streaming -------------------------------------------------------

await test('claude non-stream text is a message with content block', async () => {
  resetMock();
  routeHandlers['ct.example.com'] = () => jsonUpstream(okMessage());
  const env = makeEnv({ tier1: [node('ct')], secrets: { ct: 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'message');
  assert.equal(body.model, 'claude-x');
  assert.equal(body.content[0].type, 'text');
  assert.equal(body.content[0].text, 'hello');
  assert.equal(body.usage.input_tokens, 1);
  assert.equal(body.stop_reason, 'end_turn');
  // NATIVE chain: the request reached /v1/messages with the body forwarded
  // verbatim (model substituted only), and the credential went out as
  // x-api-key — never "Authorization: Bearer".
  const call = upstreamCalls[0];
  assert.equal(new URL(call.url).pathname, '/v1/messages');
  assert.equal(call.body.model, 'up-model');
  assert.equal(call.body.messages[0].content, 'hi');
  assert.equal(call.body.max_tokens, 64);
  assert.equal(call.headers.get('x-api-key'), 'k');
  assert.equal(call.headers.get('authorization'), null);
  assert.ok(call.headers.get('anthropic-version'));
});

await test('claude streaming passes the native event lifecycle through and hides upstream model', async () => {
  resetMock();
  routeHandlers['cs.example.com'] = () => sseResponse(textLifecycle('hi there'));
  const env = makeEnv({ tier1: [node('cs')], secrets: { cs: 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  const types = [...text.matchAll(/event: (.+)/g)].map((m) => m[1]);
  assert.equal(types[0], 'message_start');
  assert.ok(types.includes('content_block_start'));
  assert.ok(types.includes('content_block_delta'));
  assert.ok(types.includes('message_stop'));
  assert.ok(!text.includes('up-model'));
  assert.match(text, /"model":"claude-x"/);
  const state = getNodeState('cs');
  assert.equal(state.totalFailures, 0, 'a complete lifecycle is a node success');
  assert.equal(state.totalSuccesses, 1);
});

await test('claude streaming forwards anthropic-version and anthropic-beta headers natively', async () => {
  resetMock();
  routeHandlers['cv.example.com'] = () => sseResponse(textLifecycle('hi'));
  const env = makeEnv({ tier1: [node('cv')], secrets: { cv: 'k' } });
  const res = await worker.fetch(messagesRequest(
    { model: 'claude-x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] },
    { headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' } },
  ), env, {});
  assert.equal(res.status, 200);
  await res.text();
  const headers = upstreamCalls[0].headers;
  assert.equal(headers.get('anthropic-version'), '2023-06-01');
  assert.equal(headers.get('anthropic-beta'), 'prompt-caching-2024-07-31');
  assert.ok(!JSON.stringify(headers).includes(ACCESS_KEY), 'the gateway access key must never reach the upstream');
});

await test('claude a complete native lifecycle never opens a half stream', async () => {
  resetMock();
  // message_start -> thinking -> text -> message_delta -> message_stop: every
  // block closes, the lifecycle terminates with message_stop, and no error
  // event is injected by the gateway.
  routeHandlers['cdt.example.com'] = () => sseResponse([
    messageStart(),
    blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
    thinkingDelta(0, 'think-'), thinkingDelta(0, 'ing'),
    signatureDelta(0, 'sig'),
    blockStop(0),
    blockStart(1, { type: 'text', text: '' }),
    textDelta(1, 'done'),
    blockStop(1),
    messageDelta(),
    messageStop(),
  ]);
  const env = makeEnv({ tier1: [node('cdt')], secrets: { cdt: 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  const types = [...text.matchAll(/event: (.+)/g)].map((m) => m[1]);
  assert.ok(types.includes('content_block_delta'), 'content must be delivered');
  assert.ok(types.includes('message_delta'), 'a message_delta must precede message_stop');
  assert.equal(types[types.length - 1], 'message_stop', 'the stream must finalize with message_stop');
  assert.ok(!text.includes('"type":"error"'), 'no error event for a complete lifecycle');
  assert.match(text, /"thinking":"think-"/);
  assert.match(text, /"thinking":"ing"/);
  assert.match(text, /"text":"done"/);
  assert.match(text, /"signature"/);
});

await test('claude thinking blocks pass through natively', async () => {
  resetMock();
  routeHandlers['cth.example.com'] = () => sseResponse([
    messageStart(),
    blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
    thinkingDelta(0, 'think-'), thinkingDelta(0, 'ing'),
    blockStop(0),
    blockStart(1, { type: 'text', text: '' }),
    textDelta(1, 'done'),
    blockStop(1),
    messageDelta(),
    messageStop(),
  ]);
  const env = makeEnv({ tier1: [node('cth')], secrets: { cth: 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  const text = await res.text();
  assert.match(text, /"type":"thinking_delta"/);
  assert.match(text, /"type":"text_delta"/);
  // thinking streams incrementally; each delta preserves its own fragment
  assert.match(text, /"thinking":"think-"/);
  assert.match(text, /"thinking":"ing"/);
  assert.match(text, /"text":"done"/);
});

// ---- tools ------------------------------------------------------------------

await test('claude tool_use passes through as a native tool_use content block', async () => {
  resetMock();
  routeHandlers['ctu.example.com'] = () => jsonUpstream(okMessage({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } }],
  }));
  const env = makeEnv({ tier1: [node('ctu')], secrets: { ctu: 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'weather?' }] }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stop_reason, 'tool_use');
  const toolBlock = body.content.find((b) => b.type === 'tool_use');
  assert.ok(toolBlock, 'expected a tool_use block');
  assert.equal(toolBlock.name, 'get_weather');
  assert.deepEqual(toolBlock.input, { city: 'SF' });
});

await test('claude tool_use streaming assembles input_json_delta chunks', async () => {
  resetMock();
  routeHandlers['ctus.example.com'] = () => sseResponse([
    messageStart(),
    blockStart(0, { type: 'tool_use', id: 'toolu_9', name: 'get_weather', input: {} }),
    inputJsonDelta(0, '{"city":'),
    inputJsonDelta(0, '"SF"}'),
    blockStop(0),
    messageDelta('tool_use'),
    messageStop(),
  ]);
  const env = makeEnv({ tier1: [node('ctus')], secrets: { ctus: 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'weather?' }] }), env, {});
  const text = await res.text();
  assert.match(text, /"type":"tool_use"/);
  assert.match(text, /"name":"get_weather"/);
  assert.match(text, /input_json_delta/);
});

await test('claude tool_use + tool_result history is forwarded verbatim (native body)', async () => {
  resetMock();
  routeHandlers['ctr.example.com'] = () => jsonUpstream(okMessage());
  const env = makeEnv({ tier1: [node('ctr')], secrets: { ctr: 'k' } });
  const body = {
    model: 'claude-x',
    max_tokens: 64,
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny' }] },
    ],
  };
  const res = await worker.fetch(messagesRequest(body), env, {});
  assert.equal(res.status, 200);
  const sent = upstreamCalls[0].body;
  // Native: the messages array reaches the upstream EXACTLY as the client
  // sent it — content blocks stay content blocks, no OpenAI chat conversion.
  assert.deepEqual(sent.messages, body.messages);
  assert.equal(sent.model, 'up-model');
  assert.deepEqual(sent.tools, undefined);
});

await test('claude system and tools pass through natively', async () => {
  resetMock();
  routeHandlers['cst.example.com'] = () => jsonUpstream(okMessage());
  const env = makeEnv({ tier1: [node('cst')], secrets: { cst: 'k' } });
  const body = {
    model: 'claude-x',
    max_tokens: 64,
    system: 'You are terse.',
    tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    messages: [{ role: 'user', content: 'hi' }],
  };
  const res = await worker.fetch(messagesRequest(body), env, {});
  assert.equal(res.status, 200);
  const sent = upstreamCalls[0].body;
  assert.equal(sent.system, 'You are terse.');
  assert.deepEqual(sent.tools, body.tools);
});

// ---- error shapes -----------------------------------------------------------

await test('claude upstream 400 is an Anthropic invalid_request_error', async () => {
  resetMock();
  routeHandlers['ce400.example.com'] = () => jsonUpstream({ type: 'error', error: { type: 'invalid_request_error', message: 'bad shape' } }, 400);
  const env = makeEnv({ tier1: [node('ce400')], secrets: { 'ce400': 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'invalid_request_error');
});

await test('claude missing/invalid gateway key is a 401 authentication_error', async () => {
  resetMock();
  const env = makeEnv({ tier1: [node('ce401')], secrets: { 'ce401': 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }, { key: 'wrong' }), env, {});
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.type, 'authentication_error');
});

await test('claude upstream 429 after cooldown is an Anthropic rate_limit_error', async () => {
  resetMock();
  routeHandlers['ce429.example.com'] = () => jsonUpstream({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429, { 'retry-after': '30' });
  const env = makeEnv({ tier1: [node('ce429')], secrets: { 'ce429': 'k' } });
  await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.type, 'rate_limit_error');
});

await test('claude upstream 5xx rotates; final failure is an Anthropic api_error', async () => {
  resetMock();
  routeHandlers['ce5xx.example.com'] = () => jsonUpstream({ type: 'error', error: { type: 'api_error', message: 'boom' } }, 500);
  const env = makeEnv({ tier1: [node('ce5xx')], secrets: { 'ce5xx': 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'api_error');
});

await test('claude count_tokens is approximated locally without upstream calls', async () => {
  resetMock();
  const env = makeEnv({ tier1: [node('ctk')], secrets: { ctk: 'k' } });
  const res = await worker.fetch(new Request('https://gateway.example.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ACCESS_KEY },
    body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'hello world' }] }),
  }), env, {});
  assert.equal(res.status, 200);
  assert.ok((await res.json()).input_tokens > 0);
  assert.equal(upstreamCalls.length, 0);
});

await test('claude stream interruption accounts a node failure and delivers partial bytes', async () => {
  resetMock();
  const encoder = new TextEncoder();
  let step = 0;
  routeHandlers['ceint.example.com'] = () => new Response(new ReadableStream({
    pull(controller) {
      if (step === 0) { controller.enqueue(encoder.encode(textDelta(0, 'partial'))); step = 1; }
      else controller.error(new Error('upstream died mid-stream'));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const env = makeEnv({ tier1: [node('ceint')], secrets: { 'ceint': 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /partial/);
  assert.equal(getNodeState('ceint').totalFailures, 1);
});

// A message_start-only stream carries NO real model output: a node that
// announces itself and then dies has committed nothing, so the request must
// fail over to a healthy node. (First Event Guard, Anthropic semantics.)
await test('claude: message_start-only first event then EOF must fail over to a healthy node', async () => {
  resetMock();
  const encoder = new TextEncoder();
  routeHandlers['roa.example.com'] = () => new Response(new ReadableStream({
    pull(controller) {
      // lifecycle events only, then clean EOF (no real output, no message_stop).
      controller.enqueue(encoder.encode(messageStart()));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  routeHandlers['rob.example.com'] = () => sseResponse(textLifecycle('served by B'));
  recordTier1Ttft('roa', 'claude-x', 10);
  recordTier1Ttft('rob', 'claude-x', 1000);
  const env = makeEnv({ tier1: [node('roa'), node('rob')], secrets: { roa: 'k', rob: 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  assert.equal(res.status, 200, 'must fail over to B and serve');
  const text = await res.text();
  assert.match(text, /served by B/, 'B must serve');
  assert.ok(upstreamCalls.some((c) => c.host === 'roa.example.com'), 'A was contacted');
  assert.ok(upstreamCalls.some((c) => c.host === 'rob.example.com'), 'B was reached via failover');
});

// Once real output (a text delta) has been committed, transparent failover is
// forbidden — the client already saw node A's model output.
await test('claude: text delta first event then EOF must NOT fail over to another node', async () => {
  resetMock();
  const encoder = new TextEncoder();
  routeHandlers['toa.example.com'] = () => new Response(new ReadableStream({
    pull(controller) {
      // real text output, then clean EOF (committed — no failover allowed).
      controller.enqueue(encoder.encode(textDelta(0, 'committed output')));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  routeHandlers['tob.example.com'] = () => sseResponse(textLifecycle('should not serve'));
  recordTier1Ttft('toa', 'claude-x', 10);
  recordTier1Ttft('tob', 'claude-x', 1000);
  const env = makeEnv({ tier1: [node('toa'), node('tob')], secrets: { toa: 'k', tob: 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /committed output/, 'A served its committed output');
  assert.ok(!upstreamCalls.some((c) => c.host === 'tob.example.com'), 'B must never be contacted once A committed');
});

// A successful Anthropic stream MUST reach message_stop; the completionMarker
// guard means a stream that ends without it is accounted as a node failure.
await test('claude: a stream ending without message_stop is a node failure, not success', async () => {
  resetMock();
  const encoder = new TextEncoder();
  // Real text output, then clean EOF — committed, but no message_stop marker.
  routeHandlers['nms.example.com'] = () => new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(encoder.encode(textDelta(0, 'partial')));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const env = makeEnv({ tier1: [node('nms')], secrets: { nms: 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes('event: message_stop'), 'stream must be missing message_stop');
  assert.equal(getNodeState('nms').totalFailures, 1, 'a missing message_stop must count as a failure, not success');
});

// Client asked for JSON but the native upstream streamed anyway: the gateway
// assembles the final message object. Nothing reached the client during
// assembly, so a failure still rotates.
await test('claude non-stream client + streaming upstream assembles the message object', async () => {
  resetMock();
  routeHandlers['casm.example.com'] = () => sseResponse(textLifecycle('assembled'));
  const env = makeEnv({ tier1: [node('casm')], secrets: { casm: 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'message');
  assert.equal(body.model, 'claude-x');
  assert.equal(body.content[0].text, 'assembled');
  assert.equal(body.stop_reason, 'end_turn');
  assert.deepEqual(body.usage, { input_tokens: 1, output_tokens: 1 });
});

// Client asked for a stream but the native upstream answered with a full JSON
// message: the gateway synthesizes a well-formed Anthropic SSE lifecycle.
await test('claude stream client + JSON upstream synthesizes the SSE lifecycle', async () => {
  resetMock();
  routeHandlers['csyn.example.com'] = () => jsonUpstream(okMessage());
  const env = makeEnv({ tier1: [node('csyn')], secrets: { csyn: 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  const text = await res.text();
  const types = [...text.matchAll(/event: (.+)/g)].map((m) => m[1]);
  assert.equal(types[0], 'message_start');
  assert.ok(types.includes('content_block_delta'));
  assert.equal(types[types.length - 1], 'message_stop');
  assert.match(text, /"text":"hello"/);
});

if (!process.exitCode) console.log(`\nclaude (messages) contract tests passed (${passed}).`);
else process.exit(1);
