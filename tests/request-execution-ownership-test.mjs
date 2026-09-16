#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Cross-layer request-execution ownership contracts.

import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { gatewayStats } from '../src/observability/gateway-stats.ts';
import { __resetAllStateForTests } from '../src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '../src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.ts';
import { __resetAdaptive429StateForTests } from '../src/reliability/adaptive-429.ts';

const ACCESS_KEY = 'request-execution-ownership-test-key';
let calls = [];

function reset() {
  calls = [];
  __resetAllStateForTests();
  __resetTier1StateForTests();
  __resetTier1AffinityForTests();
  __resetAdaptive429StateForTests();
}

// These fixtures exercise /v1/responses, so the account declares provider
// "openai" and receives its Responses capability from provider-profile.ts.
function configNode(id, tier, models, priority = 10) {
  return {
    id,
    provider: 'openai',
    base_url: `https://${id}.example.com/v1`,
    priority,
    models,
    __tier: tier,
  };
}

function envFor(nodes, extra = {}) {
  const env = {
    GATEWAY_ACCESS_KEY_ULTRA: ACCESS_KEY,
    GATEWAY_ACCESS_MODELS_ULTRA: '*',
    PROTOCOL_FALLBACKS: 'disable',
    TIER1_SCHEDULER_SEED: 'request-execution-ownership',
    ...extra,
  };
  for (const tier of [1, 2, 3]) {
    const tierNodes = nodes.filter((node) => node.__tier === tier);
    if (!tierNodes.length) continue;
    env[`TIER${tier}_NODES_CONFIG_01`] = JSON.stringify(tierNodes.map(({ __tier, ...node }) => node));
    env[`TIER${tier}_NODES_SECRETS_01`] = JSON.stringify(
      Object.fromEntries(tierNodes.map((node) => [node.id, `secret-${node.id}`])),
    );
  }
  return env;
}

function responsesRequest(model, stream = false) {
  return new Request('https://gateway.example.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify({ model, input: 'continue the task', stream }),
  });
}

function completedResponsesObject(model, text = 'ok') {
  return {
    id: `resp_${model.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    object: 'response', status: 'completed', model,
    output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function hangingSseHeaders() {
  return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
}

function hangingErrorBody(status = 503) {
  return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function installFetch(routes) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ host: url.hostname, model: body.model });
    const handler = routes[url.hostname];
    if (!handler) throw new Error(`no mock upstream for ${url.hostname}`);
    return handler({ url, init, body });
  };
}

async function withDeadline(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

reset();
const codeMax = configNode('family-max', 1, { 'Code-Max': 'real-max' });
const codePro = configNode('family-pro', 1, { 'Code-Pro': 'real-pro' });
installFetch({
  'family-max.example.com': () => hangingSseHeaders(),
  'family-pro.example.com': () => jsonResponse(completedResponsesObject('real-pro', 'sibling recovered')),
});
const familyEnv = envFor([codeMax, codePro], {
  FAILOVER_BUDGET_MS: '1000',
  MODELS_CONFIG: JSON.stringify({ 'Code-Max': { policy: 'default' }, 'Code-Pro': { policy: 'default' } }),
  POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 2, hedge: { enabled: false } } }),
});
const familyStarted = Date.now();
const familyResponse = await withDeadline(worker.fetch(responsesRequest('Code-Max', true), familyEnv, {}), 1800, 'family failover request');
assert.equal(familyResponse.status, 200, 'a sibling model must still receive wall-clock budget after the preferred model stalls');
const familyText = await withDeadline(familyResponse.text(), 1000, 'family synthesized stream drain');
assert.match(familyText, /sibling recovered/);
assert.ok(Date.now() - familyStarted < 1800);
assert.deepEqual(calls.map((c) => c.host), ['family-max.example.com', 'family-pro.example.com']);

reset();
const badTier2 = configNode('tier2-stall', 2, { Solo: 'solo-upstream' }, 1);
const goodTier2 = configNode('tier2-good', 2, { Solo: 'solo-upstream' }, 2);
installFetch({
  'tier2-stall.example.com': () => hangingErrorBody(503),
  'tier2-good.example.com': () => jsonResponse(completedResponsesObject('solo-upstream', 'fallback node succeeded')),
});
const errorBodyEnv = envFor([badTier2, goodTier2], {
  FAILOVER_BUDGET_MS: '1000',
  MODELS_CONFIG: JSON.stringify({ Solo: { policy: 'default' } }),
  POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 2, hedge: { enabled: false } } }),
});
const errorStarted = Date.now();
const errorResponse = await withDeadline(worker.fetch(responsesRequest('Solo', false), errorBodyEnv, {}), 1800, 'non-ok diagnostic body failover');
assert.equal(errorResponse.status, 200, 'a stalled 503 diagnostic body must time out inside the attempt and rotate');
assert.match(await errorResponse.text(), /fallback node succeeded/);
assert.ok(Date.now() - errorStarted < 1800);
assert.deepEqual(calls.map((c) => c.host), ['tier2-stall.example.com', 'tier2-good.example.com']);

reset();
const synthNode = configNode('synth-json', 1, { SoloStream: 'solo-stream-upstream' });
installFetch({ 'synth-json.example.com': () => jsonResponse(completedResponsesObject('solo-stream-upstream', 'synthetic stream')) });
const synthEnv = envFor([synthNode], {
  MODELS_CONFIG: JSON.stringify({ SoloStream: { policy: 'default' } }),
  POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 1, hedge: { enabled: false } } }),
});
const activeBefore = gatewayStats.activeRequests;
const successBefore = gatewayStats.successes;
const cancelBefore = gatewayStats.cancellations;
const synthResponse = await worker.fetch(responsesRequest('SoloStream', true), synthEnv, {});
assert.equal(synthResponse.status, 200);
assert.equal(gatewayStats.activeRequests, activeBefore + 1);
const synthText = await synthResponse.text();
assert.match(synthText, /synthetic stream/);
assert.equal(gatewayStats.activeRequests, activeBefore);
assert.equal(gatewayStats.successes, successBefore + 1);
assert.equal(gatewayStats.cancellations, cancelBefore);

const cancelActiveBefore = gatewayStats.activeRequests;
const cancelSuccessBefore = gatewayStats.successes;
const cancelCountBefore = gatewayStats.cancellations;
const cancelResponse = await worker.fetch(responsesRequest('SoloStream', true), envFor([synthNode], {
  MODELS_CONFIG: JSON.stringify({ SoloStream: { policy: 'default' } }),
  POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 1, hedge: { enabled: false } } }),
}), {});
assert.equal(gatewayStats.activeRequests, cancelActiveBefore + 1);
const cancelReader = cancelResponse.body.getReader();
await cancelReader.cancel('test cancellation');
assert.equal(gatewayStats.activeRequests, cancelActiveBefore);
assert.equal(gatewayStats.cancellations, cancelCountBefore + 1);
assert.equal(gatewayStats.successes, cancelSuccessBefore);

console.log('request execution ownership tests passed.');
