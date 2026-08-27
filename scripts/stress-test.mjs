#!/usr/bin/env node
// Stress / fault-injection tests: hammer the REAL worker.fetch pipeline under
// bursts and injected faults and assert the reliability invariants hold —
//   * concurrency is never exceeded, slots never leak
//   * hard RPM never exceeds the configured cap
//   * cooling storms short-circuit (no wasted upstream calls)
//   * circuit opens on sustained failure, single-probe half-open recovers
//   * tier fallback drains the higher tier first
//   * client abort mid-stream releases everything neutrally
//   * failover budget stops further upstream calls once spent
// These are test-only; no production behavior is changed.
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { __resetAllStateForTests, getNodeState } from '../src/reliability/node-state.js';

const ACCESS_KEY = 'test-stress-key';
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

// ---- Mock upstream plumbing (same style as integration-test) --------------
const upstreamCalls = [];
let routeHandlers = {};

function installMockFetch() {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const handler = routeHandlers[url.hostname];
    if (!handler) throw new Error(`no mock upstream for ${url.hostname}`);
    if (init?.body) upstreamCalls.push({ host: url.hostname });
    const signal = init?.signal;
    // If the caller aborted before we even dispatched, surface it immediately
    // (mirrors real fetch semantics: a pre-aborted signal rejects the fetch).
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const res = handler(reqFor(url, init));
    // Wire the abort signal into the upstream stream so a mid-stream client
    // abort actually errors the body the gateway is pumping — without this the
    // abort never reaches the streaming path and the slot only releases via
    // the normal completion path (the "fake test" bug).
    if (signal && res.body) {
      const upstream = res.body;
      const onAbort = () => { try { upstream.cancel(); } catch { /* already closed */ } };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    return res;
  };
}
function reqFor(url, init) {
  return init?.body !== undefined
    ? new Request(url, { method: 'POST', headers: init.headers, body: init.body })
    : null;
}
function resetMock() { upstreamCalls.length = 0; routeHandlers = {}; }

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
  id, provider: 'mock', base_url: `https://${id}.example.com/v1`,
  models: { 'general-air': 'up-model' }, ...extra,
});
function chatRequest(body, key = ACCESS_KEY, init = {}) {
  return new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: init.signal,
  });
}
function jsonUpstream(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}
const okCompletion = { id: 'x', object: 'chat.completion', model: 'up-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] };

installMockFetch();

// ---- Invariant helper ------------------------------------------------------
// After a burst, every touched node must have released its slot and its probe.
function assertNoLeaks(ids) {
  for (const id of ids) {
    const s = getNodeState(id);
    assert.equal(s.activeRequests, 0, `node ${id} leaked ${s.activeRequests} slot(s)`);
    assert.equal(s.probeInFlight, false, `node ${id} stuck probeInFlight`);
  }
}

// ---- S1: concurrency is never exceeded and slots never leak ---------------
await test('S1 concurrency burst: never exceeds cap, slots released', async () => {
  resetMock();
  let release;
  const gate = new Promise((r) => { release = r; });
  routeHandlers['c1.example.com'] = async () => { await gate; return jsonUpstream(okCompletion); };
  const env = makeEnv({ tier1: [basicNode('c1', { limits: { concurrency: 1 } })], secrets: { c1: 'k' } });
  const inFlight = Array.from({ length: 6 }, () => worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {}));
  await new Promise((r) => setTimeout(r, 20)); // let the first claim the slot
  assert.equal(getNodeState('c1').activeRequests, 1, 'concurrency cap must be enforced');
  release();
  const statuses = await Promise.all(inFlight.map((p) => p.then((r) => r.status)));
  assert.equal(statuses.filter((s) => s === 200).length, 1, 'exactly one request served');
  assert.equal(statuses.filter((s) => s === 503).length, 5, 'the rest saturate with 503');
  assertNoLeaks(['c1']);
});

// ---- S2: hard RPM never exceeds the configured cap under a burst ----------
await test('S2 hard RPM burst: never exceeds the cap, excess yields 503', async () => {
  resetMock();
  routeHandlers['rpm1.example.com'] = () => jsonUpstream(okCompletion);
  const env = makeEnv({ tier1: [basicNode('rpm1', { limits: { concurrency: 10, rpm: 2 } })], secrets: { rpm1: 'k' } });
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    statuses.push((await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {})).status);
  }
  assert.equal(statuses.filter((s) => s === 200).length, 2, 'hard cap of 2 must hold');
  assert.equal(upstreamCalls.length, 2, 'must not hit upstream past the cap');
  assert.ok(statuses.slice(2).every((s) => s === 503), 'excess must saturate with 503');
  assertNoLeaks(['rpm1']);
});

// ---- S3: tier fallback drains tier-1 before tier-2 -------------------------
await test('S3 tier fallback: drains tier-1, then tier-2 serves', async () => {
  resetMock();
  for (const id of ['t1a', 't1b', 't1c', 't1d']) routeHandlers[`${id}.example.com`] = () => jsonUpstream({}, 503);
  routeHandlers['t2a.example.com'] = () => jsonUpstream(okCompletion);
  const env = makeEnv({
    tier1: [basicNode('t1a'), basicNode('t1b'), basicNode('t1c'), basicNode('t1d')],
    tier2: [basicNode('t2a')],
    secrets: { t1a: 'k', t1b: 'k', t1c: 'k', t1d: 'k', t2a: 'k' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamCalls.map((c) => c.host),
    ['t1a.example.com', 't1b.example.com', 't1c.example.com', 't1d.example.com', 't2a.example.com']);
  assertNoLeaks(['t1a', 't1b', 't1c', 't1d', 't2a']);
});

// ---- S4: cooling storm short-circuits (no wasted upstream calls) ----------
await test('S4 429 storm: cooling node short-circuits, no upstream hammering', async () => {
  resetMock();
  routeHandlers['cool1.example.com'] = () => jsonUpstream({ error: { message: 'rl' } }, 429, { 'retry-after': '60' });
  const env = makeEnv({ tier1: [basicNode('cool1')], secrets: { cool1: 'k' } });
  const first = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(first.status, 429);
  const callsAfterFirst = upstreamCalls.length;
  const storm = await Promise.all(Array.from({ length: 10 }, () =>
    worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {}).then((r) => r.status)));
  assert.ok(storm.every((s) => s === 429), 'all storm requests must be 429');
  assert.equal(upstreamCalls.length, callsAfterFirst, 'cooling must not re-hit upstream');
  assertNoLeaks(['cool1']);
});

// ---- S5: circuit opens under sustained failure, half-open recovers ---------
await test('S5 circuit: opens on sustained failure, single-probe half-open recovery', async () => {
  resetMock();
  let fail = true;
  let release;
  const gate = new Promise((r) => { release = r; });
  routeHandlers['cb1.example.com'] = async () => {
    if (fail) return jsonUpstream({}, 503);
    await gate; // hold the probe in flight so concurrent requests see half-open
    return jsonUpstream(okCompletion);
  };
  const env = makeEnv({ tier1: [basicNode('cb1')], secrets: { cb1: 'k' } });
  for (let i = 0; i < 3; i++) {
    const r = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
    assert.equal(r.status, 502);
  }
  assert.equal(getNodeState('cb1').circuitState, 'open');
  // OPEN: short-circuit without hitting upstream.
  const callsBefore = upstreamCalls.length;
  await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(upstreamCalls.length, callsBefore, 'open circuit must not hit upstream');

  // Expire open period -> HALF_OPEN. With the probe held on a gate, a burst must
  // admit exactly ONE probe; the rest see half-open+probeInFlight and 429.
  getNodeState('cb1').cooldownUntil = Date.now() - 1;
  fail = false;
  const before = upstreamCalls.length;
  const burst = Array.from({ length: 5 }, () =>
    worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {}).then((r) => r.status));
  await new Promise((r) => setTimeout(r, 30)); // let non-probe requests resolve (429)
  assert.equal(upstreamCalls.length - before, 1, 'exactly one probe may reach upstream');
  assert.equal(getNodeState('cb1').circuitState, 'half-open');
  assert.equal(getNodeState('cb1').probeInFlight, true);
  // Release the probe: it succeeds and closes the circuit, unblocking the burst.
  release();
  const statuses = await Promise.all(burst);
  assert.equal(statuses.filter((s) => s === 200).length, 1, 'probe request succeeds');
  assert.equal(statuses.filter((s) => s === 429).length, 4, 'concurrent requests saturate, not probe');
  assert.equal(getNodeState('cb1').circuitState, 'closed');
  assert.equal(getNodeState('cb1').probeInFlight, false);
  // Follow-up request is served normally now.
  const followUp = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(followUp.status, 200);
  assertNoLeaks(['cb1']);
});

// ---- S6: client abort mid-stream releases everything neutrally ------------
await test('S6 client abort mid-stream: releases slot, no failure penalty', async () => {
  resetMock();
  const ac = new AbortController();
  const enc = new TextEncoder();
  let step = 0;
  routeHandlers['ab1.example.com'] = () => new Response(new ReadableStream({
    async pull(c) {
      if (step === 0) { c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { content: 'a' } }] })}\n\n`)); step = 1; return; }
      await new Promise((r) => setTimeout(r, 50));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const env = makeEnv({ tier1: [basicNode('ab1')], secrets: { ab1: 'k' } });
  const resPromise = worker.fetch(chatRequest({ model: 'general-air', messages: [], stream: true }, ACCESS_KEY, { signal: ac.signal }), env, {});
  const res = await resPromise;
  // Wait for the first streamed chunk to reach the client, THEN abort mid-stream
  // (before [DONE]). This makes the abort genuinely mid-stream rather than firing
  // before the guard has even committed the first event.
  const reader = res.body.getReader();
  await reader.read();
  reader.releaseLock();
  ac.abort();
  await res.body.cancel().catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  const s = getNodeState('ab1');
  assert.equal(s.activeRequests, 0, 'abort must release the slot');
  assert.equal(s.totalFailures, 0, 'abort is neutral, not a failure');
  assert.equal(s.circuitState, 'closed');
  assertNoLeaks(['ab1']);
});

// ---- S7: failover budget stops further upstream calls ----------------------
await test('S7 failover budget: no further upstream after budget spent', async () => {
  resetMock();
  routeHandlers['slow.example.com'] = async () => { await new Promise((r) => setTimeout(r, 1600)); return jsonUpstream({}, 502); };
  routeHandlers['fast.example.com'] = () => jsonUpstream(okCompletion);
  const env = makeEnv({
    tier1: [basicNode('slow'), basicNode('fast')],
    secrets: { slow: 'k', fast: 'k' },
    extraEnv: { FAILOVER_BUDGET_MS: '1200' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 504, 'budget exhaustion must be terminal 504');
  assert.deepEqual(upstreamCalls.map((c) => c.host), ['slow.example.com'],
    'must not call the next node once the budget is spent');
  assert.equal(res.headers.get('x-should-retry'), 'false');
  assertNoLeaks(['slow', 'fast']);
});

// ---- S8: randomized fault-injection invariant sweep ------------------------
await test('S8 randomized fault injection: invariants hold across many requests', async () => {
  resetMock();
  const ids = ['f1', 'f2', 'f3'];
  for (const id of ids) {
    routeHandlers[`${id}.example.com`] = () => {
      const roll = Math.random();
      if (roll < 0.25) return jsonUpstream({}, 503);
      if (roll < 0.35) return jsonUpstream({ error: { message: 'rl' } }, 429, { 'retry-after': '5' });
      if (roll < 0.42) return jsonUpstream({}, 500);
      return jsonUpstream(okCompletion);
    };
  }
  const env = makeEnv({
    tier1: ids.map((id) => basicNode(id, { limits: { concurrency: 3, rpm: 100 } })),
    secrets: Object.fromEntries(ids.map((id) => [id, 'k'])),
  });
  const results = await Promise.all(Array.from({ length: 60 }, () =>
    worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {}).then((r) => r.status)));
  assert.ok(results.every((s) => [200, 429, 502, 503, 504].includes(s)), 'only expected terminal statuses');
  // Every node's slot accounting is balanced and no node is stuck half-open.
  for (const id of ids) {
    const s = getNodeState(id);
    assert.equal(s.activeRequests, 0, `${id} leaked slots`);
    assert.equal(s.probeInFlight, false, `${id} stuck probe`);
    assert.equal(s.totalRequests, s.totalSuccesses + s.totalFailures, `${id} outcome accounting unbalanced`);
  }
});

// ---- S9: one node 429-cooling does not disturb its siblings ---------------
await test('S9 node isolation: a 429-cooling node leaves siblings serving', async () => {
  resetMock();
  routeHandlers['iso-a.example.com'] = () => jsonUpstream({ error: { message: 'rl' } }, 429, { 'retry-after': '120' });
  routeHandlers['iso-b.example.com'] = () => jsonUpstream(okCompletion);
  routeHandlers['iso-c.example.com'] = () => jsonUpstream(okCompletion);
  const env = makeEnv({
    tier1: ['iso-a', 'iso-b', 'iso-c'].map((id) => basicNode(id, { limits: { concurrency: 20 } })),
    secrets: { 'iso-a': 'k', 'iso-b': 'k', 'iso-c': 'k' },
  });
  // First request: iso-a 429s and cools; rotation serves iso-b.
  const first = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(first.status, 200);
  assert.equal(getNodeState('iso-a').cooldownUntil > Date.now(), true, 'iso-a must be cooling');
  // Burst: iso-a is cooling and must never be hit again; siblings serve all.
  const aCalls = upstreamCalls.filter((c) => c.host === 'iso-a.example.com').length;
  const statuses = await Promise.all(Array.from({ length: 20 }, () =>
    worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {}).then((r) => r.status)));
  assert.ok(statuses.every((s) => s === 200), 'siblings must serve the whole burst');
  const aCallsAfter = upstreamCalls.filter((c) => c.host === 'iso-a.example.com').length;
  assert.equal(aCallsAfter, aCalls, 'cooling node must not be re-contacted');
  assertNoLeaks(['iso-a', 'iso-b', 'iso-c']);
});

// ---- S10: one node circuit-open does not disturb its siblings --------------
await test('S10 node isolation: a circuit-open node leaves siblings serving', async () => {
  resetMock();
  routeHandlers['cir-a.example.com'] = () => jsonUpstream({}, 503);
  routeHandlers['cir-b.example.com'] = () => jsonUpstream(okCompletion);
  routeHandlers['cir-c.example.com'] = () => jsonUpstream(okCompletion);
  const env = makeEnv({
    tier1: [
      basicNode('cir-a', { priority: 1, limits: { concurrency: 20 } }),
      basicNode('cir-b', { priority: 10, limits: { concurrency: 20 } }),
      basicNode('cir-c', { priority: 10, limits: { concurrency: 20 } }),
    ],
    secrets: { 'cir-a': 'k', 'cir-b': 'k', 'cir-c': 'k' },
  });
  // cir-a has the best priority so it is picked first and, failing every time,
  // trips the circuit after 3 counted failures.
  for (let i = 0; i < 3; i++) {
    const r = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
    assert.equal(r.status, 200);
  }
  assert.equal(getNodeState('cir-a').circuitState, 'open', 'cir-a must be circuit-open');
  const aCalls = upstreamCalls.filter((c) => c.host === 'cir-a.example.com').length;
  const statuses = await Promise.all(Array.from({ length: 20 }, () =>
    worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {}).then((r) => r.status)));
  assert.ok(statuses.every((s) => s === 200), 'siblings must serve the whole burst');
  const aCallsAfter = upstreamCalls.filter((c) => c.host === 'cir-a.example.com').length;
  assert.equal(aCallsAfter, aCalls, 'open-circuit node must not be re-contacted');
  assertNoLeaks(['cir-a', 'cir-b', 'cir-c']);
});

// ---- S11: fallback reserve keeps Tier 2 reachable when Tier 1 is wide ----
// A Tier 1 of many failing free keys must NOT eat the whole attempt budget:
// the default fallbackReservePerTier=1 holds back one attempt for every
// lower tier that can still serve the model, so the paid Tier 2 always gets
// a turn. With maxAttempts=5 and Tier 2 capable, Tier 1 is capped at 4
// attempts and Tier 2 is reached.
await test('S11 fallback reserve: a wide failing Tier 1 cannot starve Tier 2', async () => {
  resetMock();
  for (const id of ['fb1', 'fb2', 'fb3', 'fb4', 'fb5', 'fb6']) {
    routeHandlers[`${id}.example.com`] = () => jsonUpstream({}, 503);
  }
  routeHandlers['paid.example.com'] = () => jsonUpstream(okCompletion);
  const env = makeEnv({
    tier1: ['fb1', 'fb2', 'fb3', 'fb4', 'fb5', 'fb6'].map((id) => basicNode(id, { limits: { concurrency: 20 } })),
    tier2: [basicNode('paid', { limits: { concurrency: 20 } })],
    secrets: { fb1: 'k', fb2: 'k', fb3: 'k', fb4: 'k', fb5: 'k', fb6: 'k', paid: 'k' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200, 'Tier 2 must serve — fallback reserve kept it reachable');
  const tier1Calls = upstreamCalls.filter((c) => c.host.endsWith('.example.com') && c.host.startsWith('fb')).length;
  const tier2Calls = upstreamCalls.filter((c) => c.host === 'paid.example.com').length;
  assert.equal(tier2Calls, 1, 'paid Tier 2 node must be contacted exactly once');
  assert.equal(tier1Calls, 4, 'Tier 1 must be capped at maxAttempts - reserve (4), not eat all 5');
  assertNoLeaks(['fb1', 'fb2', 'fb3', 'fb4', 'fb5', 'fb6', 'paid']);
});

// ---- S12: tier_attempts override is honored (explicit per-tier budget) ----
// POLICIES_CONFIG tier_attempts overrides the computed default per-tier budget.
// Here Tier 1 is explicitly capped at 2 attempts even though it has 6 nodes, so
// a healthy Tier 2 is reached without letting Tier 1 eat the whole budget.
await test('S12 tier_attempts override: caps Tier 1 at 2 so Tier 2 serves', async () => {
  resetMock();
  for (const id of ['nb1', 'nb2', 'nb3', 'nb4', 'nb5', 'nb6']) {
    routeHandlers[`${id}.example.com`] = () => jsonUpstream({}, 503);
  }
  routeHandlers['paid2.example.com'] = () => jsonUpstream(okCompletion);
  const env = makeEnv({
    tier1: ['nb1', 'nb2', 'nb3', 'nb4', 'nb5', 'nb6'].map((id) => basicNode(id, { limits: { concurrency: 20 } })),
    tier2: [basicNode('paid2', { limits: { concurrency: 20 } })],
    secrets: { nb1: 'k', nb2: 'k', nb3: 'k', nb4: 'k', nb5: 'k', nb6: 'k', paid2: 'k' },
    extraEnv: { POLICIES_CONFIG: '{"default":{"max_attempts":5,"tier_attempts":{"tier1":2,"tier2":1}}}' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200, 'Tier 2 must serve when Tier 1 is capped by tier_attempts');
  const tier1Calls = upstreamCalls.filter((c) => c.host.startsWith('nb')).length;
  assert.equal(tier1Calls, 2, 'tier_attempts must cap Tier 1 at exactly 2 attempts');
  assert.equal(upstreamCalls.filter((c) => c.host === 'paid2.example.com').length, 1, 'Tier 2 must be reached');
  assertNoLeaks(['nb1', 'nb2', 'nb3', 'nb4', 'nb5', 'nb6', 'paid2']);
});

// ---- S13: per-tier default splits budget fairly, no tier silently starved ----
// With max_attempts=3 and three schedulable tiers (one node each), the default
// gives every tier exactly one attempt. The middle tier must be reached (not
// starved), and Tier 1 (highest priority) must be tried before it.
await test('S13 per-tier default: each schedulable tier gets a share, middle tier reached', async () => {
  resetMock();
  routeHandlers['fe1.example.com'] = () => jsonUpstream({}, 503);
  routeHandlers['fe2.example.com'] = () => jsonUpstream(okCompletion);
  routeHandlers['fe3.example.com'] = () => jsonUpstream({}, 503);
  const env = makeEnv({
    tier1: [basicNode('fe1', { limits: { concurrency: 20 } })],
    tier2: [basicNode('fe2', { limits: { concurrency: 20 } })],
    tier3: [basicNode('fe3', { limits: { concurrency: 20 } })],
    secrets: { fe1: 'k', fe2: 'k', fe3: 'k' },
    extraEnv: { POLICIES_CONFIG: '{"default":{"max_attempts":3}}' },
  });
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.equal(res.status, 200, 'request must eventually be served');
  assert.equal(upstreamCalls.filter((c) => c.host === 'fe1.example.com').length, 1, 'Tier 1 gets exactly 1 attempt');
  assert.equal(upstreamCalls.filter((c) => c.host === 'fe2.example.com').length, 1, 'middle Tier 2 is reached (not starved)');
  assert.equal(upstreamCalls.filter((c) => c.host === 'fe3.example.com').length, 0, 'Tier 3 never reached (served in Tier 2)');
  assertNoLeaks(['fe1', 'fe2', 'fe3']);
});

// ---- S14: availability-aware budget — an unusable lower tier gets no budget ----
// Tier 2's only node is cooling (cooldown/circuit), so it is NOT a schedulable
// candidate. Budget must NOT be reserved for it: Tier 1 should get the FULL
// budget instead of being capped by an unusable fallback.
await test('S14 availability-aware: a cooling Tier 2 node does not consume Tier 1 budget', async () => {
  resetMock();
  for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) {
    routeHandlers[`${id}.example.com`] = () => jsonUpstream({}, 503);
  }
  routeHandlers['cool2.example.com'] = () => jsonUpstream({ error: { message: 'rl' } }, 429, { 'retry-after': '120' });
  const env = makeEnv({
    tier1: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((id) => basicNode(id, { limits: { concurrency: 20 } })),
    tier2: [basicNode('cool2', { limits: { concurrency: 20 } })],
    secrets: { a1: 'k', a2: 'k', a3: 'k', a4: 'k', a5: 'k', a6: 'k', cool2: 'k' },
  });
  // Warm-up: 4 Tier-1 attempts (default 2-schedulable-tier share), then the
  // only Tier-2 node answers 429 and cools (retry-after 120s).
  await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  assert.ok(getNodeState('cool2').cooldownUntil > Date.now(), 'cool2 must be cooling after the warm-up');
  // Second request: cool2 is cooling -> tier-2 is NOT schedulable -> Tier 1 gets
  // the whole budget (5), never reserving an attempt for an unusable tier.
  const callsBefore = upstreamCalls.length;
  const res = await worker.fetch(chatRequest({ model: 'general-air', messages: [] }), env, {});
  const newCalls = upstreamCalls.slice(callsBefore);
  assert.equal(res.status, 502, 'Tier 1 exhausts the whole budget and no usable fallback exists');
  assert.equal(newCalls.filter((c) => c.host.startsWith('a')).length, 5,
    'Tier 1 gets the FULL budget when the only Tier-2 candidate is cooling');
  assert.equal(newCalls.filter((c) => c.host === 'cool2.example.com').length, 0,
    'a cooling Tier-2 node is never re-contacted');
  assertNoLeaks(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'cool2']);
});

if (!process.exitCode) console.log(`\nstress tests passed (${passed}).`);
else process.exit(1);