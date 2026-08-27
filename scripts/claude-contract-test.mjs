#!/usr/bin/env node
// Claude Code / Anthropic Messages contract tests.
//
// Black-box: run the REAL worker pipeline (auth -> scheduler -> retry ->
// circuit -> protocol -> stream) through worker.fetch() against a mocked
// global fetch upstream, exactly as a Claude Code client drives /v1/messages.
// These tests pin the customer-facing protocol contract (text, stream,
// thinking, tool_use, tool_result, error shapes), not internal structure.
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
    const req = init?.body !== undefined
      ? new Request(url, { method: 'POST', headers: init.headers, body: init.body })
      : null;
    if (req) upstreamCalls.push({ host: url.hostname, url, body: JSON.parse(init.body) });
    else upstreamCalls.push({ host: url.hostname, url, body: null });
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
    ...(tier1 ? { TIER1_NODES_CONFIG_01: JSON.stringify(tier1) } : {}),
    ...(tier2 ? { TIER2_NODES_CONFIG_01: JSON.stringify(tier2) } : {}),
    ...(secrets ? { NODE_SECRETS_01: JSON.stringify(secrets) } : {}),
    ...extraEnv,
  };
}

const node = (id, extra = {}) => ({
  id,
  provider: 'mock',
  base_url: `https://${id}.example.com/v1`,
  models: { 'claude-x': 'up-model' },
  ...extra,
});

function messagesRequest(body, opts = {}) {
  return new Request('https://gateway.example.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.key === undefined ? ACCESS_KEY : opts.key,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function jsonUpstream(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function sseBody(events) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= events.length) { controller.close(); return; }
      const e = events[i++];
      controller.enqueue(encoder.encode(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`));
    },
  });
}
function sseResponse(events, headers = {}) {
  return new Response(sseBody(events), { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}

const chunk = (delta) => ({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] });
const reasoningChunk = (t) => chunk({ reasoning_content: t });
const textChunk = (t) => chunk({ content: t });
const toolChunk = (index, id, name, args) => chunk({ tool_calls: [{ index, id, function: { name, arguments: args } }] });
const doneEvent = '[DONE]';
const finish = (reason = 'stop') => ({ id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const okCompletion = (over) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'up-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
  ...over,
});

installMockFetch();

// ---- text / streaming -------------------------------------------------------

await test('claude non-stream text is a message with content block', async () => {
  resetMock();
  routeHandlers['ct.example.com'] = () => jsonUpstream(okCompletion());
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
});

await test('claude streaming emits message lifecycle events and hides upstream model', async () => {
  resetMock();
  routeHandlers['cs.example.com'] = () => sseResponse([textChunk('hi there'), finish(), doneEvent]);
  const env = makeEnv({ tier1: [node('cs')], secrets: { cs: 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  const types = [...text.matchAll(/event: (.+)/g)].map((m) => m[1]);
  assert.equal(types[0], 'message_start');
  assert.ok(types.includes('content_block_start'));
  assert.ok(types.includes('message_stop'));
  assert.ok(!text.includes('up-model'));
});

await test('claude stream [DONE] without finish_reason finalizes cleanly (no half-open)', async () => {
  resetMock();
  // An OpenAI-compatible provider (e.g. a free key) ends with only [DONE] after
  // the final content delta, never sending an explicit finish_reason chunk. The
  // transform must still finalize into a complete message_stop lifecycle rather
  // than emit an error (which Claude Code treats as a half-open stream + retry).
  routeHandlers['cdt.example.com'] = () => sseResponse([textChunk('hi there'), doneEvent]);
  const env = makeEnv({ tier1: [node('cdt')], secrets: { cdt: 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  assert.equal(res.status, 200);
  const text = await res.text();
  const types = [...text.matchAll(/event: (.+)/g)].map((m) => m[1]);
  assert.ok(types.includes('content_block_delta'), 'content must be delivered');
  assert.ok(types.includes('message_delta'), 'a message_delta must follow');
  assert.ok(types.includes('message_stop'), 'the stream must finalize with message_stop');
  assert.ok(!text.includes('"type":"error"'), 'no error event for a [DONE]-terminated content stream');
  assert.match(text, /"stop_reason":"end_turn"/, 'a missing finish_reason maps to end_turn');
});

await test('claude thinking is preserved as a thinking block, not text', async () => {
  resetMock();
  routeHandlers['cth.example.com'] = () => sseResponse([reasoningChunk('think-'), reasoningChunk('ing'), textChunk('done'), finish(), doneEvent]);
  const env = makeEnv({ tier1: [node('cth')], secrets: { cth: 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  const text = await res.text();
  assert.match(text, /"type":"thinking_delta"/);
  assert.match(text, /"type":"text_delta"/);
  // thinking streams incrementally; each delta preserves its own fragment
  assert.match(text, /"thinking":"think-"/);
  assert.match(text, /"thinking":"ing"/);
  assert.match(text, /"type":"signature_delta"/);
  assert.match(text, /"text":"done"/);
});

// ---- tools ------------------------------------------------------------------

await test('claude tool_use round-trips to a tool_use content block', async () => {
  resetMock();
  routeHandlers['ctu.example.com'] = () => jsonUpstream({
    id: 'chatcmpl-1',
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
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

await test('claude tool_use + tool_result history converts to upstream chat messages', async () => {
  resetMock();
  routeHandlers['ctr.example.com'] = () => jsonUpstream(okCompletion());
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
  const assistant = sent.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.ok(assistant, 'assistant message must carry tool_calls');
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { city: 'SF' });
  const toolResult = sent.messages.find((m) => m.role === 'tool');
  assert.equal(toolResult.tool_call_id, 'toolu_1');
  assert.equal(toolResult.content, 'sunny');
});

// ---- error shapes -----------------------------------------------------------

await test('claude upstream 400 is an Anthropic invalid_request_error', async () => {
  resetMock();
  routeHandlers['ce400.example.com'] = () => jsonUpstream({ error: { message: 'bad shape' } }, 400);
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
  routeHandlers['ce429.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': '30' });
  const env = makeEnv({ tier1: [node('ce429')], secrets: { 'ce429': 'k' } });
  await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.type, 'rate_limit_error');
});

await test('claude upstream 5xx rotates; final failure is an Anthropic api_error', async () => {
  resetMock();
  routeHandlers['ce5xx.example.com'] = () => jsonUpstream({}, 500);
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
      if (step === 0) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(textChunk('partial'))}\n\n`)); step = 1; }
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

// A role-only / empty-delta / usage-only / empty-choices event is NOT real model
// output for the Anthropic path: a node that streams such an event before dying
// has committed nothing, so the request must fail over to a healthy node.
const roleOnlyChunk = () => chunk({ role: 'assistant' });

await test('claude: role-only first event then EOF must fail over to a healthy node', async () => {
  resetMock();
  const encoder = new TextEncoder();
  routeHandlers['roa.example.com'] = () => new Response(new ReadableStream({
    pull(controller) {
      // role-only event, then clean EOF (no real output, no [DONE]).
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleOnlyChunk())}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  routeHandlers['rob.example.com'] = () => sseResponse([textChunk('served by B'), finish(), doneEvent]);
  const env = makeEnv({ tier1: [node('roa'), node('rob')], secrets: { roa: 'k', rob: 'k' } });
  const res = await worker.fetch(messagesRequest({ model: 'claude-x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }), env, {});
  assert.equal(res.status, 200, 'must fail over to B and serve');
  const text = await res.text();
  assert.match(text, /served by B/, 'B must serve');
  assert.ok(upstreamCalls.some((c) => c.host === 'roa.example.com'), 'A was contacted');
  assert.ok(upstreamCalls.some((c) => c.host === 'rob.example.com'), 'B was reached via failover');
});

// Once real output (text) has been committed, transparent failover is forbidden
// — the client already saw node A's model output.
await test('claude: text first event then EOF must NOT fail over to another node', async () => {
  resetMock();
  const encoder = new TextEncoder();
  routeHandlers['toa.example.com'] = () => new Response(new ReadableStream({
    pull(controller) {
      // real text output, then clean EOF (committed — no failover allowed).
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(textChunk('committed output'))}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  routeHandlers['tob.example.com'] = () => sseResponse([textChunk('should not serve'), finish(), doneEvent]);
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
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(textChunk('partial'))}\n\n`));
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

if (!process.exitCode) console.log(`\nclaude (messages) contract tests passed (${passed}).`);
else process.exit(1);
