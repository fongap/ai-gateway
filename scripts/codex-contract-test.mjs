#!/usr/bin/env node
// Codex / OpenAI Responses contract tests.
//
// Black-box: run the REAL worker pipeline (auth -> scheduler -> retry ->
// circuit -> transport -> stream) through worker.fetch() against a mocked
// global fetch upstream, exactly as a Codex-style client would drive
// /v1/responses. These tests pin the customer-facing protocol contract, not
// internal function structure.
//
// The Responses path is NATIVE end to end: the gateway forwards the request
// body verbatim (model substituted) to the upstream /v1/responses endpoint
// and relays the upstream's native Responses SSE event sequence. Every mock
// upstream below therefore speaks the Responses wire format — no Chat
// Completions conversion exists anywhere in this path.
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

// ---- Mock upstream plumbing ------------------------------------------------

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
    if (req) {
      upstreamCalls.push({ host: url.hostname, url, body: JSON.parse(init.body), headers: init.headers });
    } else {
      upstreamCalls.push({ host: url.hostname, url, body: null, headers: init.headers });
    }
    return handler(req ?? {}, url);
  };
}

function resetMock() {
  upstreamCalls.length = 0;
  routeHandlers = {};
}

function makeEnv({ tier1, tier2, tier3, secrets, extraEnv } = {}) {
  return {
    GATEWAY_ACCESS_KEY: ACCESS_KEY,
    ...(tier1 ? { TIER1_NODES_CONFIG_01: JSON.stringify(tier1) } : {}),
    ...(tier2 ? { TIER2_NODES_CONFIG_01: JSON.stringify(tier2) } : {}),
    ...(tier3 ? { TIER3_NODES_CONFIG_01: JSON.stringify(tier3) } : {}),
    ...(secrets ? { NODE_SECRETS_01: JSON.stringify(secrets) } : {}),
    ...extraEnv,
  };
}

// OpenAI-protocol node serving /v1/responses natively.
const node = (id, extra = {}) => ({
  id,
  provider: 'mock',
  protocol: 'openai',
  surfaces: ['responses'],
  base_url: `https://${id}.example.com/v1`,
  models: { 'code-max': 'up-model' },
  ...extra,
});

function responsesRequest(body, key = ACCESS_KEY, path = '/v1/responses') {
  return new Request(`https://gateway.example.com${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key !== null ? { authorization: `Bearer ${key}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function jsonUpstream(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sseBody(lines) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= lines.length) { controller.close(); return; }
      // Upstream bodies are byte streams: every SSE line is UTF-8 encoded.
      controller.enqueue(encoder.encode(lines[i++]));
    },
  });
}
function sseResponse(lines, headers = {}) {
  return new Response(sseBody(lines), { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

// ---- Native Responses wire shapes -------------------------------------------

let seq = 0;
const nextSeq = () => seq++;
const responseCreated = (model = 'up-model') => event('response.created', {
  type: 'response.created', sequence_number: nextSeq(),
  response: { id: 'resp_up1', object: 'response', created_at: 1, status: 'in_progress', model, output: [], usage: {} },
});
const itemAdded = (outputIndex, item) => event('response.output_item.added', {
  type: 'response.output_item.added', sequence_number: nextSeq(), output_index: outputIndex, item,
});
const textDeltaEvent = (itemId, outputIndex, delta) => event('response.output_text.delta', {
  type: 'response.output_text.delta', sequence_number: nextSeq(), item_id: itemId, output_index: outputIndex, content_index: 0, delta,
});
const textDoneEvent = (itemId, outputIndex, text) => event('response.output_text.done', {
  type: 'response.output_text.done', sequence_number: nextSeq(), item_id: itemId, output_index: outputIndex, content_index: 0, text,
});
const reasoningDeltaEvent = (itemId, outputIndex, delta) => event('response.reasoning_text.delta', {
  type: 'response.reasoning_text.delta', sequence_number: nextSeq(), item_id: itemId, output_index: outputIndex, content_index: 0, delta,
});
const fnArgsDeltaEvent = (itemId, outputIndex, delta) => event('response.function_call_arguments.delta', {
  type: 'response.function_call_arguments.delta', sequence_number: nextSeq(), item_id: itemId, output_index: outputIndex, delta,
});
const itemDone = (outputIndex, item) => event('response.output_item.done', {
  type: 'response.output_item.done', sequence_number: nextSeq(), output_index: outputIndex, item,
});
const responseCompleted = (response) => event('response.completed', { type: 'response.completed', sequence_number: nextSeq(), response });

const messageItem = (id, text) => ({
  id, type: 'message', status: 'completed', role: 'assistant',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const reasoningItem = (id, text) => ({
  id, type: 'reasoning', status: 'completed',
  content: [{ type: 'reasoning_text', text }], summary: [],
});
const functionCallItem = (id, callId, name, argsJson) => ({
  id, type: 'function_call', status: 'completed', call_id: callId, name, arguments: argsJson,
});

// A complete native text-only stream lifecycle.
const textLifecycle = (text) => {
  seq = 0;
  const item = messageItem('msg_1', text);
  return [
    responseCreated(),
    itemAdded(0, { ...item, status: 'in_progress', content: [] }),
    textDeltaEvent('msg_1', 0, text),
    textDoneEvent('msg_1', 0, text),
    itemDone(0, item),
    responseCompleted({
      id: 'resp_up1', object: 'response', created_at: 1, status: 'completed',
      model: 'up-model', output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
  ];
};

// A complete native non-stream response object.
const okResponse = (over = {}) => ({
  id: 'resp_up1',
  object: 'response',
  created_at: 1,
  status: 'completed',
  model: 'up-model',
  output: [messageItem('msg_1', 'hello')],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  ...over,
});

installMockFetch();

// Parse the `response` payload of a `response.completed` SSE event.
function parseCompletedResponse(text) {
  const after = text.split('event: response.completed\n')[1];
  const line = after.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line.slice(6)).response;
}

// ---- Non-stream Responses ---------------------------------------------------

await test('responses non-stream passes the native object through (model hidden)', async () => {
  resetMock();
  routeHandlers['rns.example.com'] = () => jsonUpstream(okResponse());
  const env = makeEnv({ tier1: [node('rns')], secrets: { rns: 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, 'response');
  assert.equal(body.status, 'completed');
  assert.equal(body.model, 'code-max'); // logical model preserved
  assert.equal(body.output[0].type, 'message');
  assert.equal(body.output[0].content[0].text, 'hello');
  assert.equal(body.usage.input_tokens, 1);
  // NATIVE chain: the request reached /v1/responses with the body forwarded
  // verbatim (model substituted only) — never converted to chat completions.
  const call = upstreamCalls[0];
  assert.equal(new URL(call.url).pathname, '/v1/responses');
  assert.equal(call.body.model, 'up-model');
  assert.equal(call.body.input[0].content[0].text, 'hi');
});

await test('responses stream relays the native event lifecycle (model hidden)', async () => {
  resetMock();
  routeHandlers['rss.example.com'] = () => sseResponse(textLifecycle('hello world'));
  const env = makeEnv({ tier1: [node('rss')], secrets: { rss: 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi', stream: true }), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  const events = [...text.matchAll(/event: ([^\n]+)/g)].map((m) => m[1]);
  assert.equal(events[0], 'response.created');
  assert.equal(events[events.length - 1], 'response.completed');
  assert.ok(events.includes('response.output_item.added'));
  assert.ok(events.includes('response.output_text.delta'));
  assert.ok(events.includes('response.output_text.done'));
  assert.equal(events.indexOf('response.created'), 0);
  assert.ok(!text.includes('up-model'), 'upstream model must never leak');
  assert.match(text, /"model":"code-max"/);
  const state = getNodeState('rss');
  assert.equal(state.totalFailures, 0, 'a large response.completed event must not be misclassified as truncation');
  assert.equal(state.totalSuccesses, 1);
});

await test('responses reasoning items pass through natively', async () => {
  resetMock();
  seq = 0;
  const reasoning = reasoningItem('rs_1', 'think-ing');
  const message = messageItem('msg_1', 'answer');
  routeHandlers['rsn.example.com'] = () => sseResponse([
    responseCreated(),
    itemAdded(0, { ...reasoning, status: 'in_progress', content: [] }),
    reasoningDeltaEvent('rs_1', 0, 'think-'),
    reasoningDeltaEvent('rs_1', 0, 'ing'),
    itemDone(0, reasoning),
    itemAdded(1, { ...message, status: 'in_progress', content: [] }),
    textDeltaEvent('msg_1', 1, 'answer'),
    itemDone(1, message),
    responseCompleted({
      id: 'resp_up1', object: 'response', created_at: 1, status: 'completed',
      model: 'up-model', output: [reasoning, message],
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    }),
  ]);
  const env = makeEnv({ tier1: [node('rsn')], secrets: { rsn: 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi', stream: true }), env, {});
  const text = await res.text();
  const completed = parseCompletedResponse(text);
  assert.deepEqual(completed.output.map((o) => o.type), ['reasoning', 'message']);
  assert.equal(completed.output[0].content[0].type, 'reasoning_text');
  assert.equal(completed.output[0].content[0].text, 'think-ing');
  assert.equal(completed.output[1].content[0].text, 'answer');
  assert.match(text, /response\.reasoning_text\.delta/);
});

await test('responses function call: arguments deltas stream natively', async () => {
  resetMock();
  seq = 0;
  const call = functionCallItem('fc_1', 'call_1', 'get_weather', '{"city":"SF"}');
  routeHandlers['rfn.example.com'] = () => sseResponse([
    responseCreated(),
    itemAdded(0, { ...call, status: 'in_progress' }),
    fnArgsDeltaEvent('fc_1', 0, '{"city":'),
    fnArgsDeltaEvent('fc_1', 0, '"SF"}'),
    itemDone(0, call),
    responseCompleted({
      id: 'resp_up1', object: 'response', created_at: 1, status: 'completed',
      model: 'up-model', output: [call],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
  ]);
  const env = makeEnv({ tier1: [node('rfn')], secrets: { rfn: 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi', stream: true }), env, {});
  const text = await res.text();
  const events = [...text.matchAll(/event: ([^\n]+)/g)].map((m) => m[1]);
  assert.ok(events.includes('response.function_call_arguments.delta'));
  const completed = parseCompletedResponse(text);
  assert.equal(completed.output[0].type, 'function_call');
  assert.equal(completed.output[0].name, 'get_weather');
  assert.equal(completed.output[0].call_id, 'call_1');
  assert.deepEqual(JSON.parse(completed.output[0].arguments), { city: 'SF' });
});

await test('responses multiple parallel tool calls keep native call ids', async () => {
  resetMock();
  seq = 0;
  const callA = functionCallItem('fc_a', 'call_a', 'get_a', '{"a":1}');
  const callB = functionCallItem('fc_b', 'call_b', 'get_b', '{"b":2}');
  routeHandlers['rmt.example.com'] = () => sseResponse([
    responseCreated(),
    itemAdded(0, { ...callA, status: 'in_progress' }),
    fnArgsDeltaEvent('fc_a', 0, '{"a":'),
    itemAdded(1, { ...callB, status: 'in_progress' }),
    fnArgsDeltaEvent('fc_b', 1, '{"b":'),
    fnArgsDeltaEvent('fc_a', 0, '1}'),
    fnArgsDeltaEvent('fc_b', 1, '2}'),
    itemDone(0, callA),
    itemDone(1, callB),
    responseCompleted({
      id: 'resp_up1', object: 'response', created_at: 1, status: 'completed',
      model: 'up-model', output: [callA, callB],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
  ]);
  const env = makeEnv({ tier1: [node('rmt')], secrets: { rmt: 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi', stream: true }), env, {});
  const text = await res.text();
  const completed = parseCompletedResponse(text);
  assert.equal(completed.output.length, 2);
  assert.equal(completed.output[0].call_id, 'call_a');
  assert.equal(completed.output[1].call_id, 'call_b');
  assert.deepEqual(JSON.parse(completed.output[0].arguments), { a: 1 });
  assert.deepEqual(JSON.parse(completed.output[1].arguments), { b: 2 });
});

// ---- failover / error semantics ---------------------------------------------

await test('responses non-stream upstream 429 rotates to a healthy node', async () => {
  resetMock();
  routeHandlers['r429a.example.com'] = () => jsonUpstream({ error: { message: 'rate' } }, 429, { 'retry-after': '60' });
  routeHandlers['r429b.example.com'] = () => jsonUpstream(okResponse());
  const env = makeEnv({ tier1: [node('r429a'), node('r429b')], secrets: { 'r429a': 'k', 'r429b': 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi' }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['r429a.example.com', 'r429b.example.com']);
});

await test('responses all nodes cooling returns Responses-shaped 429 with Retry-After', async () => {
  resetMock();
  routeHandlers['r429c.example.com'] = () => jsonUpstream({ error: { message: 'rate' } }, 429, { 'retry-after': '30' });
  const env = makeEnv({ tier1: [node('r429c')], secrets: { 'r429c': 'k' } });
  await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi' }), env, {});
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi' }), env, {});
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  const body = await res.json();
  assert.equal(body.error.type, 'rate_limit_error');
  assert.equal(body.error.param, null);
  assert.equal(body.error.code, null);
});

await test('responses upstream 5xx rotates to a healthy node', async () => {
  resetMock();
  routeHandlers['r5xxa.example.com'] = () => jsonUpstream({}, 503);
  routeHandlers['r5xxb.example.com'] = () => jsonUpstream(okResponse());
  const env = makeEnv({ tier1: [node('r5xxa'), node('r5xxb')], secrets: { 'r5xxa': 'k', 'r5xxb': 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi' }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['r5xxa.example.com', 'r5xxb.example.com']);
});

await test('responses first-event failover: empty upstream rotates before any event', async () => {
  resetMock();
  routeHandlers['fe-a.example.com'] = () => sseResponse([]);
  routeHandlers['fe-b.example.com'] = () => sseResponse(textLifecycle('ok'));
  const env = makeEnv({ tier1: [node('fe-a'), node('fe-b')], secrets: { 'fe-a': 'k', 'fe-b': 'k' }, extraEnv: { EXPOSE_UPSTREAM_INFO: 'true' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi', stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls.length, 2);
  assert.equal(res.headers.get('x-gateway-node'), 'fe-b');
  const text = await res.text();
  assert.match(text, /response\.completed/);
});

// Lifecycle-only events (response.created) are NOT real output: a node that
// announces itself and then dies can still be failed over. But once a
// response.*.delta has committed the boundary, no transparent failover may
// happen — the client already saw partial model output.
await test('responses mid-stream failure never fails over after first event', async () => {
  resetMock();
  const encoder = new TextEncoder();
  let step = 0;
  routeHandlers['mid-a.example.com'] = () => new Response(new ReadableStream({
    pull(controller) {
      if (step === 0) {
        controller.enqueue(encoder.encode(responseCreated()));
        step = 1;
      } else if (step === 1) {
        controller.enqueue(encoder.encode(textDeltaEvent('msg_1', 0, 'partial')));
        step = 2;
      } else if (step === 2) {
        controller.enqueue(encoder.encode(textDeltaEvent('msg_1', 0, ' output')));
        step = 3;
      } else controller.error(new Error('upstream died mid-stream'));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  routeHandlers['mid-b.example.com'] = () => sseResponse(textLifecycle('SHOULD NOT SERVE'));
  const env = makeEnv({ tier1: [node('mid-a'), node('mid-b')], secrets: { 'mid-a': 'k', 'mid-b': 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi', stream: true }), env, {});
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    try { const { done, value } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); }
    catch { break; }
  }
  assert.match(text, /"delta":"partial"/, 'the first committed delta reached the client');
  assert.match(text, /"delta":" output"/, 'the second delta reached the client');
  assert.equal((text.match(/event: error\b/g) || []).length, 1,
    'exactly one protocol-shaped interruption error event is emitted');
  assert.match(text, /stream_interrupted/);
  assert.ok(!upstreamCalls.some((c) => c.host === 'mid-b.example.com'), 'must not fail over after first event');
  assert.equal(getNodeState('mid-a').totalFailures, 1, 'a mid-stream death is a node failure');
});

await test('responses created-only then EOF rotates to a healthy node', async () => {
  resetMock();
  const encoder = new TextEncoder();
  routeHandlers['co-a.example.com'] = () => new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(encoder.encode(responseCreated()));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  routeHandlers['co-b.example.com'] = () => sseResponse(textLifecycle('served by B'));
  const env = makeEnv({ tier1: [node('co-a'), node('co-b')], secrets: { 'co-a': 'k', 'co-b': 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi', stream: true }), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /served by B/, 'B must serve after A produced no real output');
  assert.ok(upstreamCalls.some((c) => c.host === 'co-b.example.com'), 'failover reached B');
});

await test('responses unknown model returns 404-shaped gateway error', async () => {
  resetMock();
  const env = makeEnv({ tier1: [node('u404')], secrets: { 'u404': 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'nope', input: 'hi' }), env, {});
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.type, 'not_found_error');
});

await test('responses missing auth returns 401 without touching upstream', async () => {
  resetMock();
  const env = makeEnv({ tier1: [node('a401')], secrets: { 'a401': 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi' }, null), env, {});
  assert.equal(res.status, 401);
  assert.equal(upstreamCalls.length, 0);
});

await test('terminal errors carry x-should-retry:false but 429 stays retryable', async () => {
  resetMock();
  routeHandlers['hdr.example.com'] = () => jsonUpstream({}, 503);
  const env = makeEnv({ tier1: [node('hdr')], secrets: { hdr: 'k' } });
  // all-nodes-failed -> 502 terminal
  const res502 = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi' }), env, {});
  assert.equal(res502.status, 502);
  assert.equal(res502.headers.get('x-should-retry'), 'false');

  // upstream 429 -> retryable: no x-should-retry:false header
  resetMock();
  routeHandlers['hdr2.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': '60' });
  const env2 = makeEnv({ tier1: [node('hdr2')], secrets: { hdr2: 'k' } });
  const res429 = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi' }), env2, {});
  assert.equal(res429.status, 429);
  assert.notEqual(res429.headers.get('x-should-retry'), 'false');
});

// ---- native passthrough semantics -------------------------------------------

await test('responses tools and host-managed features pass through natively', async () => {
  resetMock();
  routeHandlers['pt.example.com'] = () => jsonUpstream(okResponse());
  const env = makeEnv({ tier1: [node('pt')], secrets: { pt: 'k' } });
  const body = {
    model: 'code-max',
    input: 'hi',
    tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: {} } }],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    mcp_servers: [{ type: 'mcp', server_label: 'x', server_url: 'https://x' }],
  };
  const res = await worker.fetch(responsesRequest(body), env, {});
  assert.equal(res.status, 200, 'native forwarding must not reject provider-level features');
  const sent = upstreamCalls[0].body;
  assert.deepEqual(sent.tools, body.tools);
  assert.deepEqual(sent.mcp_servers, body.mcp_servers);
  assert.equal(sent.parallel_tool_calls, false);
});

await test('responses instructions / reasoning effort / metadata pass through verbatim', async () => {
  resetMock();
  routeHandlers['stk.example.com'] = () => jsonUpstream(okResponse());
  const env = makeEnv({ tier1: [node('stk')], secrets: { stk: 'k' } });
  const body = {
    model: 'code-max', input: 'hi',
    instructions: 'be terse',
    reasoning: { effort: 'high' },
    temperature: 0.2, top_p: 0.9,
    stop_sequences: ['STOP'], top_k: 2,
    metadata: { user_id: 'u1' },
  };
  const res = await worker.fetch(responsesRequest(body), env, {});
  assert.equal(res.status, 200);
  const sent = upstreamCalls[0].body;
  assert.equal(sent.instructions, 'be terse');
  assert.deepEqual(sent.reasoning, { effort: 'high' });
  assert.equal(sent.temperature, 0.2);
  assert.deepEqual(sent.stop_sequences, ['STOP']);
  assert.equal(sent.top_k, 2);
  assert.deepEqual(sent.metadata, { user_id: 'u1' });
});

await test('responses input function_call + function_call_output history is forwarded verbatim', async () => {
  resetMock();
  routeHandlers['rt.example.com'] = () => jsonUpstream(okResponse());
  const env = makeEnv({ tier1: [node('rt')], secrets: { rt: 'k' } });
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what time' }] },
    { type: 'function_call', call_id: 'call_0', name: 'get_time', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_0', output: '12:00' },
  ];
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input }), env, {});
  assert.equal(res.status, 200);
  const sent = upstreamCalls[0].body;
  // Native: the input item array reaches the upstream EXACTLY as sent.
  assert.deepEqual(sent.input, input);
});

await test('responses stream request + JSON upstream synthesizes the SSE lifecycle', async () => {
  resetMock();
  routeHandlers['rsyn.example.com'] = () => jsonUpstream(okResponse());
  const env = makeEnv({ tier1: [node('rsyn')], secrets: { rsyn: 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi', stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  const text = await res.text();
  const events = [...text.matchAll(/event: ([^\n]+)/g)].map((m) => m[1]);
  assert.equal(events[0], 'response.created');
  assert.ok(events.includes('response.output_text.delta'));
  assert.equal(events[events.length - 1], 'response.completed');
  const completed = parseCompletedResponse(text);
  assert.equal(completed.model, 'code-max');
  assert.equal(completed.output[0].content[0].text, 'hello');
});

await test('responses non-stream request + streaming upstream assembles the response object', async () => {
  resetMock();
  routeHandlers['rasm.example.com'] = () => sseResponse(textLifecycle('assembled'));
  const env = makeEnv({ tier1: [node('rasm')], secrets: { rasm: 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi' }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, 'response');
  assert.equal(body.status, 'completed');
  assert.equal(body.model, 'code-max');
  assert.equal(body.output[0].content[0].text, 'assembled');
  assert.equal(body.usage.input_tokens, 1);
});

if (!process.exitCode) console.log(`\ncodex (responses) contract tests passed (${passed}).`);
else process.exit(1);
