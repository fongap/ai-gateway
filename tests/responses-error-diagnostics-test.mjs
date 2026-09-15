#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Responses/Codex terminal-error diagnostics contract. Gateway-owned routing
// failures use stable error.code values plus non-sensitive aggregate headers;
// ordinary protocol/upstream errors keep the standard Responses envelope with
// code=null.

import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { buildResponsesError } from '../src/protocol/responses/index.ts';
import { __resetAllStateForTests } from '../src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '../src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.ts';
import { __resetAdaptive429StateForTests } from '../src/reliability/adaptive-429.ts';

const ACCESS_KEY = 'responses-diagnostics-key';
let routeHandlers = {};

function reset() {
  __resetAllStateForTests();
  __resetTier1StateForTests();
  __resetTier1AffinityForTests();
  __resetAdaptive429StateForTests();
  routeHandlers = {};
}

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const handler = routeHandlers[url.hostname];
  if (!handler) throw new Error(`no mock upstream for ${url.hostname}`);
  if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  return handler(input, init);
};

const node = (id) => ({
  id,
  provider: 'mock',
  protocol: 'openai',
  surfaces: ['responses'],
  base_url: `https://${id}.example.com/v1`,
  models: { 'code-max': 'up-model' },
});

function envFor(id) {
  return {
    GATEWAY_ACCESS_KEY_AIR: ACCESS_KEY,
    GATEWAY_ACCESS_MODELS_AIR: '*',
    TIER1_SCHEDULER_SEED: 'responses-diagnostics-test',
    TIER1_NODES_CONFIG_01: JSON.stringify([node(id)]),
    TIER1_NODES_SECRETS_01: JSON.stringify({ [id]: 'k' }),
  };
}

function request(model = 'code-max') {
  return new Request('https://gateway.example.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify({ model, input: 'hi' }),
  });
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// Envelope compatibility: code remains nullable and accepts a stable gateway
// code without adding a gateway-specific details object.
assert.equal(buildResponsesError('x', 'api_error').error.code, null);
assert.equal(
  buildResponsesError('x', 'api_error', 'gateway_upstream_exhausted').error.code,
  'gateway_upstream_exhausted',
);

// A second request while the only account is cooling performs no dispatch.
reset();
routeHandlers['cool.example.com'] = () => json({ error: { message: 'rate' } }, 429, { 'retry-after': '30' });
const coolingEnv = envFor('cool');
await worker.fetch(request(), coolingEnv, {});
const cooling = await worker.fetch(request(), coolingEnv, {});
assert.equal(cooling.status, 429);
const coolingBody = await cooling.json();
assert.equal(coolingBody.error.type, 'rate_limit_error');
assert.equal(coolingBody.error.code, 'gateway_no_dispatchable_node');
assert.equal(cooling.headers.get('x-gateway-attempts'), '0');
assert.equal(cooling.headers.get('x-gateway-dispatches'), '0');
assert.equal(cooling.headers.get('x-gateway-hedges'), '0');
assert.equal(cooling.headers.get('x-gateway-failure-kinds'), null);
assert.ok(Number(cooling.headers.get('retry-after')) > 0);

// Real upstream exhaustion gets a stable gateway code and aggregate failure
// diagnostics, but never node/provider/credential topology.
reset();
routeHandlers['dead.example.com'] = () => json({}, 503);
const dead = await worker.fetch(request(), envFor('dead'), {});
assert.equal(dead.status, 502);
const deadBody = await dead.json();
assert.equal(deadBody.error.type, 'api_error');
assert.equal(deadBody.error.code, 'gateway_upstream_exhausted');
assert.equal(dead.headers.get('x-gateway-attempts'), '1');
assert.equal(dead.headers.get('x-gateway-dispatches'), '1');
assert.equal(dead.headers.get('x-gateway-hedges'), '0');
assert.equal(dead.headers.get('x-gateway-failure-kinds'), 'server:1');
assert.equal(dead.headers.get('x-gateway-node'), null);
assert.equal(dead.headers.get('x-gateway-provider'), null);

// Upstream client errors are not reclassified as gateway routing failures.
// Counts remain available for diagnosis while the standard code stays null.
reset();
routeHandlers['badreq.example.com'] = () => json({ error: { message: 'bad input' } }, 400);
const badReq = await worker.fetch(request(), envFor('badreq'), {});
assert.equal(badReq.status, 400);
const badReqBody = await badReq.json();
assert.equal(badReqBody.error.type, 'invalid_request_error');
assert.equal(badReqBody.error.code, null);
assert.equal(badReq.headers.get('x-gateway-attempts'), '1');
assert.equal(badReq.headers.get('x-gateway-dispatches'), '1');

// Preflight errors have no scheduler activity and must not pretend they do.
reset();
const unknown = await worker.fetch(request('not-a-model'), envFor('unused'), {});
assert.equal(unknown.status, 404);
const unknownBody = await unknown.json();
assert.equal(unknownBody.error.type, 'not_found_error');
assert.equal(unknownBody.error.code, null);
assert.equal(unknown.headers.get('x-gateway-attempts'), null);
assert.equal(unknown.headers.get('x-gateway-dispatches'), null);

console.log('responses error diagnostics tests passed.');
