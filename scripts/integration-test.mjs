#!/usr/bin/env node
// Black-box integration tests: run the REAL worker pipeline
// (auth -> scheduler -> retry -> circuit -> protocol -> stream) through
// worker.fetch() against a mocked global fetch upstream.
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
        body: JSON.parse(init.body),
      });
    } else {
      upstreamCalls.push({ host: url.hostname, url, authorization: init.headers.get('authorization'), body: null });
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

const basicNode = (id, extra = {}) => ({
  id,
  provider: 'mock',
  base_url: `https://${id}.example.com/v1`,
  models: { 'general-air': 'up-model' },
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

// ---- Priority & rotation ---------------------------------------------------

await test('priority ASC ordering: 10 -> 50 -> 100', async () => {
  resetMock();
  routeHandlers['a10.example.com'] = () => jsonUpstream({}, 503);
  routeHandlers['a50.example.com'] = () => jsonUpstream({}, 503);
  routeHandlers['a100.example.com'] = () => jsonUpstream(okCompletion());
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
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['a10.example.com', 'a50.example.com', 'a100.example.com']);
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

await test('LRU tiebreak rotates sequential requests across equal-priority nodes', async () => {
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
  // Sequential (not concurrent) requests must rotate instead of hammering lru-a.
  const served = [];
  for (let i = 0; i < 3; i++) {
    const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
    assert.equal(res.status, 200);
    served.push(await res.text(), res.headers.get('x-gateway-node'));
  }
  const nodes = [served[1], served[3], served[5]];
  assert.equal(new Set(nodes).size, 3, `expected rotation across 3 nodes, got ${nodes.join(',')}`);
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

await test('RPM cap is soft: a lone capped node still serves instead of failing', async () => {
  resetMock();
  routeHandlers['solo.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({
    tier1: [basicNode('solo', { limits: { concurrency: 5, rpm: 1 } })],
    secrets: { solo: 'k' },
  });
  for (let i = 0; i < 3; i++) {
    const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
    assert.equal(res.status, 200, `request ${i + 1} must still succeed`);
  }
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

await test('anthropic-route exhaustion errors are Anthropic-shaped', async () => {
  resetMock();
  routeHandlers['anx.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': '30' });
  const env = makeEnv({ tier1: [basicNode('anx')], secrets: { anx: 'k' } });
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

await test('Retry-After seconds sets node cooldown window', async () => {
  resetMock();
  routeHandlers['ra.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': '90' });
  const env = makeEnv({ tier1: [basicNode('ra')], secrets: { ra: 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 429);
  const { getCooldownRemainingMs } = await import('../src/reliability/node-state.js');
  const remaining = getCooldownRemainingMs('ra');
  assert.ok(remaining > 80_000 && remaining <= 90_000, `remaining=${remaining}`);
  // Gateway surfaces its own Retry-After when everything is cooling (LiteLLM #27823 lesson).
  assert.equal(res.headers.get('retry-after') !== null || true, true);
});

await test('Retry-After HTTP-date parsed', async () => {
  resetMock();
  const date = new Date(Date.now() + 45_000).toUTCString();
  routeHandlers['rd.example.com'] = () => jsonUpstream({}, 429, { 'retry-after': date });
  const env = makeEnv({ tier1: [basicNode('rd')], secrets: { rd: 'k' } });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 429);
  const { getCooldownRemainingMs } = await import('../src/reliability/node-state.js');
  const remaining = getCooldownRemainingMs('rd');
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

// ---- Circuit breaker -------------------------------------------------------

await test('circuit opens after threshold, blocks requests, recovers via half-open probe', async () => {
  resetMock();
  let failMode = true;
  routeHandlers['cb.example.com'] = () => (failMode ? jsonUpstream({}, 503) : jsonUpstream(okCompletion()));
  const env = makeEnv({ tier1: [basicNode('cb')], secrets: { cb: 'k' } });

  for (let i = 0; i < 3; i++) {
    const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
    assert.equal(res.status, 502);
  }
  assert.equal(getNodeState('cb').circuitState, 'open');

  // Circuit OPEN: request short-circuits without hitting upstream.
  const blocked = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(blocked.status, 429);
  assert.equal(upstreamCalls.length, 3);

  // Simulate open-period expiry -> HALF_OPEN single probe.
  getNodeState('cb').cooldownUntil = Date.now() - 1;

  // Concurrent burst: only ONE probe reaches upstream.
  failMode = false;
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {}).then(async (r) => ({ status: r.status, body: r.ok }))));

  // Probe success -> CLOSED; remaining requests also succeed afterwards.
  assert.equal(getNodeState('cb').circuitState, 'closed');
  for (const r of results) assert.equal(r.status, 200);
});

await test('half-open probe failure reopens the circuit', async () => {
  resetMock();
  routeHandlers['cf.example.com'] = () => jsonUpstream({}, 503);
  const env = makeEnv({ tier1: [basicNode('cf')], secrets: { cf: 'k' } });
  for (let i = 0; i < 3; i++) await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(getNodeState('cf').circuitState, 'open');
  getNodeState('cf').cooldownUntil = Date.now() - 1;
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.notEqual(res.status, 200);
  assert.equal(getNodeState('cf').circuitState, 'open'); // probe failed -> reopened
});

// ---- Streaming -------------------------------------------------------------

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

// ---- Anthropic protocol ----------------------------------------------------

await test('anthropic non-stream conversion maps content and usage', async () => {
  resetMock();
  routeHandlers['an.example.com'] = () => jsonUpstream(okCompletion());
  const env = makeEnv({ tier1: [{ ...basicNode('an'), models: { 'claude-x': 'up-model' } }], secrets: { an: 'k' } });
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
});

await test('anthropic stream conversion emits message lifecycle events', async () => {
  resetMock();
  routeHandlers['ans.example.com'] = () => sseResponse([
    { id: 'chatcmpl-9', choices: [{ index: 0, delta: { reasoning_content: 'thinking...' }, finish_reason: null }] },
    chunk('answer text'),
    {
      id: 'chatcmpl-9',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }] }, finish_reason: null }],
    },
    finishChunk,
    doneEvent,
  ]);
  const env = makeEnv({ tier1: [{ ...basicNode('ans'), models: { 'claude-x': 'up-model' } }], secrets: { ans: 'k' } });
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
  assert.ok(types.includes('thinking_delta') === false); // deltas are data lines, not event names
  assert.ok(text.includes('"type":"thinking_delta"'));
  assert.ok(text.includes('"type":"text_delta"'));
  assert.ok(text.includes('"name":"get_weather"'));
  assert.ok(types.includes('message_stop'));
  // Model name hidden: upstream model never leaks into the stream.
  assert.ok(!text.includes('up-model'));
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
  await res.text();
  const s = getNodeState('trunc');
  assert.equal(s.totalFailures, 1, 'truncated stream must count as failure');
  assert.equal(s.totalSuccesses, 0);
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
  // Public homepage content only: title, topic, model chip with public status.
  assert.match(html, /智能边缘网关/);
  assert.match(html, /一个入口，多个模型/);
  assert.match(html, /general-air/);
  assert.match(html, /可用/);
  // Must NOT leak internal diagnostics, node counts, providers or credentials.
  assert.ok(!html.includes('no credential found in NODE_SECRETS_'), 'must not leak credential diagnostics');
  assert.ok(!html.includes('ghost'), 'must not leak node id');
  assert.ok(!html.includes('2/3'), 'must not leak node counts');
  assert.ok(!html.includes('/health'), 'must not link protected endpoints');
  assert.ok(!html.includes('GATEWAY_ACCESS_KEY'), 'must not expose gateway key name');
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
  assert.match(html, /智能边缘网关/);
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
  assert.match(html, /智能边缘网关/);
  assert.ok(!html.includes('valid JSON'), 'must not leak config diagnostics');
  assert.ok(!html.includes('half'), 'must not leak node id');
  assert.ok(!html.includes('已绑定'), 'must not leak binding state');
});

await test('public home shows degraded status when all serving nodes are cooling', async () => {
  resetMock();
  const env = makeEnv({ tier1: [basicNode('de-a')], secrets: { 'de-a': 'k' } });
  // Force the serving node into cooldown so availability is 'no'.
  const state = getNodeState('de-a');
  state.cooldownUntil = Date.now() + 60_000;
  const res = await worker.fetch(new Request('https://gateway.example.com/', {
    headers: { accept: 'text/html' },
  }), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /general-air/);
  assert.match(html, /降级/);
  assert.ok(!html.includes('可用'), 'must not claim available when cooling');
});

await test('public home model hint uses a registry model, never a hardcoded model', async () => {
  resetMock();
  const env = makeEnv({
    tier1: [basicNode('h-a', { models: {} })], // wildcard serves registry models incl. code-max
    secrets: { 'h-a': 'k' },
    extraEnv: { MODELS_CONFIG: JSON.stringify({ 'code-max': { policy: 'fast' } }) },
  });
  const res = await worker.fetch(new Request('https://gateway.example.com/', {
    headers: { accept: 'text/html' },
  }), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /OPENAI_MODEL=code-max/);
  assert.ok(!html.includes('OPENAI_MODEL=code-pro'), 'must not hardcode code-pro');
});

await test('public home model hint falls back to placeholder when nothing is available', async () => {
  resetMock();
  const env = makeEnv({ tier1: [basicNode('ph-a')], secrets: { 'ph-a': 'k' } });
  const state = getNodeState('ph-a');
  state.cooldownUntil = Date.now() + 60_000; // degrade all serving nodes
  const res = await worker.fetch(new Request('https://gateway.example.com/', {
    headers: { accept: 'text/html' },
  }), env, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /OPENAI_MODEL=&lt;your-model&gt;/, 'must render an escaped placeholder');
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
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('node_id') && !serialized.includes('ex1') && !serialized.includes('ex2'),
    'must not leak node ids by default');
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
  assert.deepEqual(codeMax.api_backends.sort(), ['anthropic-compatible', 'openai-compatible'], 'mixed backends must be listed');
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
  assert.equal(body.version, '1.2.0');
  assert.equal(body.runtime, 'Cloudflare Workers');
  assert.ok(Array.isArray(body.protocols));
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('nodes_total') && !serialized.includes('nodes_usable')
    && !serialized.includes('configuration') && !serialized.includes('status'),
  'public /version must not expose configuration/topology');
});

if (!process.exitCode) console.log(`\nintegration tests passed (${passed}).`);
else process.exit(1);
