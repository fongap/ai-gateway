#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Stress / fault-injection coverage for the current scheduler contract.
// There is no default configured node concurrency or node RPM admission. These
// tests hammer soft in-flight ranking, optional explicit admission, cooldown/
// recovery, tier fallback, cancellation, and the request-wide wall-clock budget
// through the real worker pipeline.

import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { __resetAllStateForTests, getNodeState } from '../src/reliability/node-state.ts';
import {
  __resetTier1StateForTests,
  getTier1Model,
  tier1AccountInFlight,
  recordTier1Ttft,
} from '../src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.ts';
import { __resetAdaptive429StateForTests } from '../src/reliability/adaptive-429.ts';
import { gatewayStats } from '../src/observability/gateway-stats.ts';

const ACCESS_KEY = 'test-stress-key';
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

const upstreamCalls = [];
let routeHandlers = {};

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const handler = routeHandlers[url.hostname];
  if (!handler) throw new Error(`no mock upstream for ${url.hostname}`);
  if (init?.body !== undefined) upstreamCalls.push({ host: url.hostname });
  if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  return handler(input, url, init);
};

function resetMock() {
  upstreamCalls.length = 0;
  routeHandlers = {};
}

function makeEnv({ tier1, tier2, tier3, secrets = {}, extraEnv = {} } = {}) {
  const subset = (nodes = []) => Object.fromEntries(
    nodes.map((n) => [n.id, secrets[n.id]]).filter(([, value]) => value !== undefined),
  );
  const t1s = subset(tier1);
  const t2s = subset(tier2);
  const t3s = subset(tier3);
  return {
    GATEWAY_ACCESS_KEY_AIR: ACCESS_KEY,
    GATEWAY_ACCESS_MODELS_AIR: '*',
    TIER1_SCHEDULER_SEED: 'stress-test',
    ...(tier1 ? { TIER1_NODES_CONFIG_01: JSON.stringify(tier1) } : {}),
    ...(tier2 ? { TIER2_NODES_CONFIG_01: JSON.stringify(tier2) } : {}),
    ...(tier3 ? { TIER3_NODES_CONFIG_01: JSON.stringify(tier3) } : {}),
    ...(Object.keys(t1s).length ? { TIER1_NODES_SECRETS_01: JSON.stringify(t1s) } : {}),
    ...(Object.keys(t2s).length ? { TIER2_NODES_SECRETS_01: JSON.stringify(t2s) } : {}),
    ...(Object.keys(t3s).length ? { TIER3_NODES_SECRETS_01: JSON.stringify(t3s) } : {}),
    ...extraEnv,
  };
}

const node = (id, extra = {}) => ({
  id,
  provider: 'mock',
  base_url: `https://${id}.example.com/v1`,
  models: { 'general-air': 'up-model' },
  ...extra,
});

function chatRequest(body = {}, init = {}) {
  return new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify({ model: 'general-air', messages: [], ...body }),
    signal: init.signal,
  });
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const okCompletion = {
  id: 'x', object: 'chat.completion', model: 'up-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function assertNoLeaks(ids) {
  for (const id of ids) {
    assert.equal(tier1AccountInFlight(id), 0, `Tier 1 account ${id} leaked an in-flight slot`);
    const state = getNodeState(id);
    assert.equal(state.activeRequests, 0, `node ${id} leaked ${state.activeRequests} active request(s)`);
    assert.equal(state.probeInFlight, false, `node ${id} stuck probeInFlight`);
  }
  assert.equal(gatewayStats.activeRequests, 0, 'gateway client activeRequests must return to zero');
}

await test('S1 burst: default Tier 1 has no guessed per-account concurrency ceiling', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  routeHandlers['burst.example.com'] = async () => { await gate; return jsonResponse(okCompletion); };
  const env = makeEnv({ tier1: [node('burst')], secrets: { burst: 'k' } });
  const requests = Array.from({ length: 8 }, () => worker.fetch(chatRequest(), env, {}));
  for (let i = 0; i < 100 && upstreamCalls.length < 8; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(upstreamCalls.length, 8, 'default policy must not reject primary traffic at an invented local ceiling');
  assert.equal(tier1AccountInFlight('burst'), 8);
  release();
  const statuses = await Promise.all(requests.map((p) => p.then((r) => r.status)));
  assert.equal(statuses.filter((s) => s === 200).length, 8, 'all default burst requests should succeed');
  assertNoLeaks(['burst']);
});

await test('S2 pool burst: P2C spreads live work without a default hard ceiling', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ids = ['p1', 'p2', 'p3', 'p4'];
  for (const id of ids) routeHandlers[`${id}.example.com`] = async () => { await gate; return jsonResponse(okCompletion); };
  const env = makeEnv({ tier1: ids.map((id) => node(id)), secrets: Object.fromEntries(ids.map((id) => [id, 'k'])) });
  const requests = Array.from({ length: 20 }, () => worker.fetch(chatRequest(), env, {}));
  for (let i = 0; i < 100 && upstreamCalls.length < 20; i++) await new Promise((r) => setTimeout(r, 5));
  const used = new Set(upstreamCalls.map((c) => c.host));
  assert.equal(upstreamCalls.length, 20, 'all default burst requests must reach an eligible Tier 1 node');
  assert.equal(ids.reduce((sum, id) => sum + tier1AccountInFlight(id), 0), 20, 'the pool must hold all 20 concurrent requests before release');
  assert.ok(used.size >= 2, `expected P2C to spread live work, got ${JSON.stringify([...used])}`);
  release();
  const statuses = await Promise.all(requests.map((p) => p.then((r) => r.status)));
  assert.equal(statuses.filter((s) => s === 200).length, 20, 'all default pool requests should succeed');
  assertNoLeaks(ids);
});

await test('S2b explicit max_in_flight=4 remains an opt-in admission ceiling', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  routeHandlers['capped.example.com'] = async () => { await gate; return jsonResponse(okCompletion); };
  const env = makeEnv({
    tier1: [node('capped')],
    secrets: { capped: 'k' },
    extraEnv: { POLICIES_CONFIG: JSON.stringify({ default: { max_in_flight: 4 } }) },
  });
  const settled = [];
  const requests = Array.from({ length: 8 }, () => worker.fetch(chatRequest(), env, {}).then((response) => {
    settled.push(response.status);
    return response;
  }));
  for (let i = 0; i < 100 && (upstreamCalls.length < 4 || settled.length < 4); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(upstreamCalls.length, 4, 'explicit max_in_flight=4 must cap this account at four concurrent dispatches');
  assert.equal(tier1AccountInFlight('capped'), 4);
  assert.equal(settled.length, 4, 'excess requests should be rejected while the explicit ceiling is occupied');
  assert.ok(settled.every((status) => status !== 200));
  release();
  const statuses = await Promise.all(requests.map((p) => p.then((r) => r.status)));
  assert.equal(statuses.filter((s) => s === 200).length, 4);
  assert.equal(statuses.filter((s) => s !== 200).length, 4);
  assertNoLeaks(['capped']);
});

await test('S3 tier fallback drains eligible Tier 1 candidates before Tier 2 serves', async () => {
  const tier1Ids = ['t1a', 't1b', 't1c', 't1d'];
  for (const id of tier1Ids) routeHandlers[`${id}.example.com`] = () => jsonResponse({}, 503);
  routeHandlers['t2.example.com'] = () => jsonResponse(okCompletion);
  const env = makeEnv({
    tier1: tier1Ids.map((id) => node(id)),
    tier2: [node('t2')],
    secrets: { t1a: '1', t1b: '2', t1c: '3', t1d: '4', t2: '5' },
  });
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 200);
  const hosts = upstreamCalls.map((c) => c.host);
  assert.equal(hosts.length, 5);
  assert.equal(new Set(hosts.slice(0, 4)).size, 4);
  assert.ok(hosts.slice(0, 4).every((host) => /^t1[abcd]\.example\.com$/.test(host)));
  assert.equal(hosts[4], 't2.example.com');
  assertNoLeaks([...tier1Ids, 't2']);
});

await test('S4 429 storm: a cooling key short-circuits without upstream hammering', async () => {
  routeHandlers['cool.example.com'] = () => jsonResponse({ error: { message: 'rate limited' } }, 429, { 'retry-after': '60' });
  const env = makeEnv({ tier1: [node('cool')], secrets: { cool: 'k' } });
  const first = await worker.fetch(chatRequest(), env, {});
  assert.equal(first.status, 429);
  const callsAfterFirst = upstreamCalls.length;
  const statuses = await Promise.all(Array.from({ length: 20 }, () =>
    worker.fetch(chatRequest(), env, {}).then((r) => r.status)));
  assert.ok(statuses.every((status) => status === 429));
  assert.equal(upstreamCalls.length, callsAfterFirst, 'cooldown must absorb the storm locally');
  assertNoLeaks(['cool']);
});

await test('S5 recovery: sustained failure admits one real half-open request at a time', async () => {
  let fail = true;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  routeHandlers['recover.example.com'] = async () => {
    if (fail) return jsonResponse({}, 503);
    await gate;
    return jsonResponse(okCompletion);
  };
  const env = makeEnv({ tier1: [node('recover')], secrets: { recover: 'k' } });
  for (let i = 0; i < 3; i++) {
    const res = await worker.fetch(chatRequest(), env, {});
    assert.equal(res.status, 502);
  }
  assert.equal(getTier1Model('recover', 'general-air').failureState, 'cooldown');
  const beforeBlocked = upstreamCalls.length;
  const blocked = await worker.fetch(chatRequest(), env, {});
  assert.notEqual(blocked.status, 200);
  assert.equal(upstreamCalls.length, beforeBlocked);

  getTier1Model('recover', 'general-air').cooldownUntil = Date.now() - 1;
  fail = false;
  const beforeProbe = upstreamCalls.length;
  const burst = Array.from({ length: 6 }, () => worker.fetch(chatRequest(), env, {}).then((r) => r.status));
  for (let i = 0; i < 100 && upstreamCalls.length === beforeProbe; i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(upstreamCalls.length - beforeProbe, 1, 'only one recovery request reaches upstream');
  assert.equal(getTier1Model('recover', 'general-air').failureState, 'half_open');
  release();
  const statuses = await Promise.all(burst);
  assert.equal(statuses.filter((s) => s === 200).length, 1);
  assert.equal(statuses.filter((s) => s !== 200).length, 5);
  const secondRecovery = await worker.fetch(chatRequest(), env, {});
  assert.equal(secondRecovery.status, 200);
  assert.equal(getTier1Model('recover', 'general-air').failureState, 'normal');
  assertNoLeaks(['recover']);
});

await test('S6 client cancellation after stream commit releases the Tier 1 slot neutrally', async () => {
  const encoder = new TextEncoder();
  let controller;
  routeHandlers['cancel.example.com'] = () => new Response(new ReadableStream({
    start(c) { controller = c; },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const env = makeEnv({ tier1: [node('cancel')], secrets: { cancel: 'k' } });
  const ac = new AbortController();
  const pending = worker.fetch(chatRequest({ stream: true }, { signal: ac.signal }), env, {});
  for (let i = 0; i < 100 && !controller; i++) await new Promise((r) => setTimeout(r, 5));
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { content: 'first' }, finish_reason: null }] })}\n\n`));
  const res = await pending;
  const reader = res.body.getReader();
  await reader.read();
  assert.equal(tier1AccountInFlight('cancel'), 1);
  ac.abort();
  await reader.cancel().catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tier1AccountInFlight('cancel'), 0);
  assert.equal(getNodeState('cancel').totalFailures, 0);
  assertNoLeaks(['cancel']);
});

await test('S7 failover wall-clock budget prevents dispatch after the budget is spent', async () => {
  routeHandlers['slow.example.com'] = async () => {
    await new Promise((r) => setTimeout(r, 1_600));
    return jsonResponse({}, 502);
  };
  routeHandlers['fast.example.com'] = () => jsonResponse(okCompletion);
  recordTier1Ttft('slow', 'general-air', 50);
  recordTier1Ttft('fast', 'general-air', 2_000);
  const env = makeEnv({
    tier1: [node('slow'), node('fast')],
    secrets: { slow: 's', fast: 'f' },
    extraEnv: { FAILOVER_BUDGET_MS: '1200' },
  });
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 504);
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['slow.example.com']);
  assert.equal(res.headers.get('x-should-retry'), 'false');
  assertNoLeaks(['slow', 'fast']);
});

await test('S8 mixed transient failures under load do not leak scheduler state', async () => {
  const ids = ['mix-a', 'mix-b', 'mix-c'];
  let callNo = 0;
  for (const id of ids) {
    routeHandlers[`${id}.example.com`] = () => {
      callNo++;
      if (callNo % 5 === 0) return jsonResponse({}, 503);
      return jsonResponse(okCompletion);
    };
  }
  const env = makeEnv({
    tier1: ids.map((id) => node(id)),
    secrets: Object.fromEntries(ids.map((id) => [id, 'k'])),
  });
  const statuses = [];
  for (let i = 0; i < 40; i++) {
    statuses.push((await worker.fetch(chatRequest(), env, {})).status);
  }
  assert.ok(statuses.filter((status) => status === 200).length >= 35);
  assertNoLeaks(ids);
});

if (!process.exitCode) console.log(`\nstress tests passed (${passed}).`);
else process.exit(1);
