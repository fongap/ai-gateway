#!/usr/bin/env node
// Codex / OpenAI Responses contract tests.
//
// Black-box: run the REAL worker pipeline (auth -> scheduler -> retry ->
// circuit -> protocol -> stream) through worker.fetch() against a mocked
// global fetch upstream, exactly as a Codex-style client would drive
// /v1/responses. These tests pin the customer-facing protocol contract, not
// internal function structure.
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

const node = (id, extra = {}) => ({
  id,
  provider: 'mock',
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
  return new Response(sseBody(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

const chunk = (delta) => ({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] });
const reasoningChunk = (t) => chunk({ reasoning_content: t });
const textChunk = (t) => chunk({ content: t });
const toolChunk = (index, id, name, args) => chunk({ tool_calls: [{ index, id, function: { name, arguments: args } }] });
const doneEvent = '[DONE]';
const finish = (reason = 'stop') => ({ id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const okCompletion = () => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'up-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

installMockFetch();

// Parse the `response` payload of a `response.completed` SSE event.
function parseCompletedResponse(text) {
  const after = text.split('event: response.completed\n')[1];
  const line = after.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line.slice(6)).response;
}

// ---- Non-stream Responses ---------------------------------------------------

await test('responses non-stream converts completion to a Responses object', async () => {
  resetMock();
  routeHandlers['rns.example.com'] = () => jsonUpstream(okCompletion());
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
  assert.equal(upstreamCalls[0].body.model, 'up-model'); // upstream name
});

await test('responses stream emits response.created -> output -> response.completed', async () => {
  resetMock();
  routeHandlers['rss.example.com'] = () => sseResponse([textChunk('hello'), textChunk(' world'), finish(), doneEvent]);
  const env = makeEnv({ tier1: [node('rss')], secrets: { rss: 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: [{ type: 'message', role: 'user', content: 'hi' }], stream: true }), env, {});
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
});

await test('responses reasoning is preserved as a reasoning item, not text', async () => {
  resetMock();
  routeHandlers['rsn.example.com'] = () => sseResponse([reasoningChunk('think-'), reasoningChunk('ing'), textChunk('answer'), finish(), doneEvent]);
  const env = makeEnv({ tier1: [node('rsn')], secrets: { rsn: 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: [{ type: 'message', role: 'user', content: 'hi' }], stream: true }), env, {});
  const text = await res.text();
  const completed = parseCompletedResponse(text);
  assert.deepEqual(completed.output.map((o) => o.type), ['reasoning', 'message']);
  assert.equal(completed.output[0].content[0].type, 'reasoning_text');
  assert.equal(completed.output[0].content[0].text, 'think-ing');
  assert.equal(completed.output[1].content[0].text, 'answer');
});

await test('responses function call: arguments deltas assemble into one call', async () => {
  resetMock();
  routeHandlers['rfn.example.com'] = () => sseResponse([
    toolChunk(0, 'call_1', 'get_weather', '{"city":'),
    toolChunk(0, 'call_1', '', '"SF"}'),
    finish('tool_calls'), doneEvent,
  ]);
  const env = makeEnv({ tier1: [node('rfn')], secrets: { rfn: 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: [{ type: 'message', role: 'user', content: 'hi' }], stream: true }), env, {});
  const text = await res.text();
  const events = [...text.matchAll(/event: ([^\n]+)/g)].map((m) => m[1]);
  assert.ok(events.includes('response.function_call_arguments.delta'));
  const completed = parseCompletedResponse(text);
  assert.equal(completed.output[0].type, 'function_call');
  assert.equal(completed.output[0].name, 'get_weather');
  assert.equal(completed.output[0].call_id, 'call_1');
  assert.deepEqual(JSON.parse(completed.output[0].arguments), { city: 'SF' });
});

await test('responses multiple parallel tool calls preserve call ids', async () => {
  resetMock();
  routeHandlers['rmt.example.com'] = () => sseResponse([
    toolChunk(0, 'call_a', 'get_a', '{"a":'),
    toolChunk(1, 'call_b', 'get_b', '{"b":'),
    toolChunk(0, 'call_a', '', '1}'),
    toolChunk(1, 'call_b', '', '2}'),
    finish('tool_calls'), doneEvent,
  ]);
  const env = makeEnv({ tier1: [node('rmt')], secrets: { rmt: 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: [{ type: 'message', role: 'user', content: 'hi' }], stream: true }), env, {});
  const text = await res.text();
  const completed = parseCompletedResponse(text);
  assert.equal(completed.output.length, 2);
  assert.equal(completed.output[0].call_id, 'call_a');
  assert.equal(completed.output[1].call_id, 'call_b');
  assert.deepEqual(JSON.parse(completed.output[0].arguments), { a: 1 });
  assert.deepEqual(JSON.parse(completed.output[1].arguments), { b: 2 });
});

await test('responses non-stream upstream 429 rotates to a healthy node', async () => {
  resetMock();
  routeHandlers['r429a.example.com'] = () => jsonUpstream({ error: { message: 'rate' } }, 429, { 'retry-after': '60' });
  routeHandlers['r429b.example.com'] = () => jsonUpstream(okCompletion());
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
  routeHandlers['r5xxb.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({ tier1: [node('r5xxa'), node('r5xxb')], secrets: { 'r5xxa': 'k', 'r5xxb': 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi' }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['r5xxa.example.com', 'r5xxb.example.com']);
});

await test('responses first-event failover: empty upstream rotates before any event', async () => {
  resetMock();
  routeHandlers['fe-a.example.com'] = () => sseResponse([]);
  routeHandlers['fe-b.example.com'] = () => sseResponse([textChunk('ok'), finish(), doneEvent]);
  const env = makeEnv({ tier1: [node('fe-a'), node('fe-b')], secrets: { 'fe-a': 'k', 'fe-b': 'k' }, extraEnv: { EXPOSE_UPSTREAM_INFO: 'true' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi', stream: true }), env, {});
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls.length, 2);
  assert.equal(res.headers.get('x-gateway-node'), 'fe-b');
  const text = await res.text();
  assert.match(text, /response\.completed/);
});

await test('responses mid-stream failure never fails over after first event', async () => {
  resetMock();
  const encoder = new TextEncoder();
  let step = 0;
  routeHandlers['mid-a.example.com'] = () => new Response(new ReadableStream({
    pull(controller) {
      if (step === 0) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(textChunk('partial'))}\n\n`)); step = 1; }
      else if (step === 1) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(textChunk(' output'))}\n\n`)); step = 2; }
      else controller.error(new Error('upstream died mid-stream'));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  routeHandlers['mid-b.example.com'] = () => sseResponse([textChunk('SHOULD NOT SERVE'), finish(), doneEvent]);
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
  assert.match(text, /partial output/);
  assert.ok(!upstreamCalls.some((c) => c.host === 'mid-b.example.com'), 'must not fail over after first event');
});

await test('responses unsupported tool type returns 400 without touching upstream', async () => {
  resetMock();
  const env = makeEnv({ tier1: [node('ut')], secrets: { ut: 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi', tools: [{ type: 'web_search' }] }), env, {});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.type, 'invalid_request_error');
  assert.equal(upstreamCalls.length, 0);
});

await test('responses input function_call + function_call_output round-trips as tool history', async () => {
  resetMock();
  routeHandlers['rt.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({ tier1: [node('rt')], secrets: { rt: 'k' } });
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what time' }] },
    { type: 'function_call', call_id: 'call_0', name: 'get_time', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_0', output: '12:00' },
  ];
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input }), env, {});
  assert.equal(res.status, 200);
  const sent = upstreamCalls[0].body;
  assert.ok(sent.messages.some((m) => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'call_0'));
  assert.ok(sent.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_0' && m.content === '12:00'));
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

  // 400 (request-shape, unrecoverable) -> x-should-retry:false
  const res400 = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi', tools: [{ type: 'web_search' }] }), env, {});
  assert.equal(res400.status, 400);
  assert.equal(res400.headers.get('x-should-retry'), 'false');

  // upstream 429 -> retryable: no x-should-retry:false header
  resetMock();
  routeHandlers['hdr2.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': '60' });
  const env2 = makeEnv({ tier1: [node('hdr2')], secrets: { hdr2: 'k' } });
  const res429 = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi' }), env2, {});
  assert.equal(res429.status, 429);
  assert.notEqual(res429.headers.get('x-should-retry'), 'false');
});

await test('unsupported Responses fields return 400 naming the field', async () => {
  resetMock();
  const env = makeEnv({ tier1: [node('uf')], secrets: { uf: 'k' } });
  const cases = [
    { mcp_servers: [{ type: 'mcp', url: 'https://x' }] },
    { context_management: { edits: [{ type: 'custom_edit', x: 1 }] } },
    { output_config: { effort: 'high', format: 'json' } },
    { extra_body: { x: 1 } },
  ];
  for (const extra of cases) {
    const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi', ...extra }), env, {});
    assert.equal(res.status, 400, JSON.stringify(extra));
    const body = await res.json();
    assert.equal(body.error.type, 'invalid_request_error');
    assert.match(body.error.message, /without data loss/);
  }
  assert.equal(upstreamCalls.length, 0);
});

await test('stop_sequences / top_k are converted, not rejected', async () => {
  resetMock();
  routeHandlers['stk.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({ tier1: [node('stk')], secrets: { stk: 'k' } });
  const res = await worker.fetch(responsesRequest({
    model: 'code-max', input: 'hi', stop_sequences: ['STOP'], top_k: 2,
  }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls[0].body.stop, ['STOP']);
  assert.equal(upstreamCalls[0].body.top_k, 2);
});

await test('reasoning summary facet is preserved when the upstream exposes it', async () => {
  resetMock();
  routeHandlers['rsum.example.com'] = () => jsonUpstream({
    id: 'chatcmpl-1', model: 'up-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'answer', reasoning_content: 'vis think', reasoning_summary: 'the summary' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
  const env = makeEnv({ tier1: [node('rsum')], secrets: { rsum: 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi' }), env, {});
  const body = await res.json();
  const item = body.output.find((o) => o.type === 'reasoning');
  assert.ok(item, 'expected a reasoning item');
  assert.equal(item.content[0].type, 'reasoning_text');
  assert.equal(item.content[0].text, 'vis think');
  assert.equal(item.summary[0].type, 'summary_text');
  assert.equal(item.summary[0].text, 'the summary');
  assert.equal(item.encrypted_content, undefined);
});

await test('encrypted reasoning is preserved verbatim, never flattened to text', async () => {
  resetMock();
  routeHandlers['renc.example.com'] = () => jsonUpstream({
    id: 'chatcmpl-1', model: 'up-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'answer', reasoning_encrypted_content: 'opaque-enc' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
  const env = makeEnv({ tier1: [node('renc')], secrets: { renc: 'k' } });
  const res = await worker.fetch(responsesRequest({ model: 'code-max', input: 'hi' }), env, {});
  const body = await res.json();
  const item = body.output.find((o) => o.type === 'reasoning');
  assert.ok(item, 'expected a reasoning item');
  assert.equal(item.encrypted_content, 'opaque-enc');
  assert.equal(item.content, undefined, 'encrypted reasoning must not be flattened into content');
  assert.ok(!body.output.some((o) => o.type === 'reasoning' && o.content && o.content.some((c) => c.text === 'opaque-enc')));
});

if (!process.exitCode) console.log(`\ncodex (responses) contract tests passed (${passed}).`);
else process.exit(1);
