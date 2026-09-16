#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio

import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { failedDomainNodeIds, modelFailureDomainKey, rememberFailedDomains } from '../src/request/model-fallback.ts';
import { __resetAllStateForTests } from '../src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '../src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.ts';
import { __resetAdaptive429StateForTests } from '../src/reliability/adaptive-429.ts';

const ACCESS_KEY = 'family-domain-test-key';
let calls = [];
function reset() {
  calls = [];
  __resetAllStateForTests();
  __resetTier1StateForTests();
  __resetTier1AffinityForTests();
  __resetAdaptive429StateForTests();
}

// Direct helper consumers still use RuntimeNode, which includes resolved wire
// fields. When projected back into config JSON below, those fields are omitted.
function node(id, models) {
  return {
    id, tier: 'tier-1', provider: 'openai', protocol: 'openai', surfaces: ['responses'],
    baseUrl: `https://${id}.example.com/v1`, credential: `secret-${id}`, priority: 10, models,
  };
}

const shared = node('acct-a', { 'Code-Max': 'real-shared', 'Code-Pro': 'real-shared', 'Code-Ultra': 'real-ultra' });
const peer = node('acct-b', { 'Code-Pro': 'real-shared' });
assert.equal(modelFailureDomainKey(shared, 'Code-Max'), modelFailureDomainKey(shared, 'Code-Pro'));
assert.notEqual(modelFailureDomainKey(shared, 'Code-Max'), modelFailureDomainKey(shared, 'Code-Ultra'));
assert.notEqual(modelFailureDomainKey(shared, 'Code-Pro'), modelFailureDomainKey(peer, 'Code-Pro'));
assert.doesNotMatch(modelFailureDomainKey(shared, 'Code-Max'), /secret-acct-a/);

const failed = new Set();
rememberFailedDomains(failed, new Map([[shared.id, shared]]), new Set([shared.id]), 'Code-Max');
assert.deepEqual([...failedDomainNodeIds([shared], 'Code-Pro', failed)], ['acct-a']);
assert.deepEqual([...failedDomainNodeIds([shared], 'Code-Ultra', failed)], []);

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const body = init?.body ? JSON.parse(init.body) : {};
  calls.push({ host: url.hostname, model: body.model });
  return new Response(JSON.stringify({ error: { message: 'temporary upstream failure' } }), {
    status: 503, headers: { 'content-type': 'application/json' },
  });
};

function envFor(nodes) {
  const configs = nodes.map(({ id, provider, baseUrl, priority, models }) => ({
    id, provider, base_url: baseUrl, priority, models,
  }));
  return {
    GATEWAY_ACCESS_KEY_ULTRA: ACCESS_KEY,
    GATEWAY_ACCESS_MODELS_ULTRA: '*',
    TIER1_SCHEDULER_SEED: 'family-domain-test',
    PROTOCOL_FALLBACKS: 'disable',
    TIER1_NODES_CONFIG_01: JSON.stringify(configs),
    TIER1_NODES_SECRETS_01: JSON.stringify(Object.fromEntries(nodes.map((n) => [n.id, n.credential]))),
  };
}

function request() {
  return new Request('https://gateway.example.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify({ model: 'Code-Max', input: 'continue the task' }),
  });
}

reset();
const oneDomain = node('shared-account', {
  'Code-Max': 'same-real-model', 'Code-Pro': 'same-real-model', 'Code-Ultra': 'same-real-model',
});
const collapsed = await worker.fetch(request(), envFor([oneDomain]), {});
assert.equal(collapsed.status, 503);
const collapsedBody = await collapsed.json();
assert.match(collapsedBody?.error?.message || '', /compatible-model failover plan/i);
assert.equal(collapsed.headers.get('x-gateway-error-code'), 'gateway_attempt_budget_exhausted');
assert.deepEqual(calls, [{ host: 'shared-account.example.com', model: 'same-real-model' }]);
assert.equal(collapsed.headers.get('x-gateway-attempts'), '1');
assert.equal(collapsed.headers.get('x-gateway-dispatches'), '1');
assert.equal(collapsed.headers.get('x-gateway-failure-kinds'), 'server:1');

reset();
const distinctModels = node('multi-model-account', {
  'Code-Max': 'real-max', 'Code-Pro': 'real-pro', 'Code-Ultra': 'real-ultra',
});
const distinct = await worker.fetch(request(), envFor([distinctModels]), {});
assert.equal(distinct.status, 503);
assert.deepEqual(calls.map((c) => c.model), ['real-max', 'real-pro', 'real-ultra']);
assert.equal(distinct.headers.get('x-gateway-attempts'), '3');
assert.equal(distinct.headers.get('x-gateway-dispatches'), '3');
assert.equal(distinct.headers.get('x-gateway-failure-kinds'), 'server:3');

reset();
const accountA = node('account-a', { 'Code-Max': 'real-shared', 'Code-Pro': 'real-shared', 'Code-Ultra': 'real-shared' });
const accountB = node('account-b', { 'Code-Max': 'real-shared', 'Code-Pro': 'real-shared', 'Code-Ultra': 'real-shared' });
const twoAccounts = await worker.fetch(request(), envFor([accountA, accountB]), {});
assert.equal(twoAccounts.status, 503);
assert.equal(calls.length, 2);
assert.deepEqual(new Set(calls.map((c) => c.host)), new Set(['account-a.example.com', 'account-b.example.com']));
assert.equal(twoAccounts.headers.get('x-gateway-attempts'), '2');

console.log('model-family failure-domain tests passed.');
