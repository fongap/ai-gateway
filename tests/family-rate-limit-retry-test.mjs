#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio

import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { __resetAllStateForTests } from '../src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '../src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.ts';

const ACCESS_KEY = 'family-rate-limit-test-key';
const calls = [];
__resetAllStateForTests();
__resetTier1StateForTests();
__resetTier1AffinityForTests();

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const body = init?.body ? JSON.parse(init.body) : {};
  calls.push({ host: url.hostname, model: body.model });
  return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '30' },
  });
};

const nodes = [
  { id: 'code-ultra-rl', provider: 'provider-ultra', base_url: 'https://code-ultra-rl.example.com/v1', priority: 10, models: { 'Code-Ultra': 'up-code-ultra' } },
  { id: 'code-max-rl', provider: 'provider-max', base_url: 'https://code-max-rl.example.com/v1', priority: 10, models: { 'Code-Max': 'up-code-max' } },
  { id: 'code-pro-rl', provider: 'provider-pro', base_url: 'https://code-pro-rl.example.com/v1', priority: 10, models: { 'Code-Pro': 'up-code-pro' } },
];

const env = {
  GATEWAY_ACCESS_KEY_ULTRA: ACCESS_KEY,
  GATEWAY_ACCESS_MODELS_ULTRA: '*',
  PROTOCOL_FALLBACKS: 'disable',
  TIER1_NODES_CONFIG_01: JSON.stringify(nodes),
  TIER1_NODES_SECRETS_01: JSON.stringify({
    'code-ultra-rl': 'k-ultra', 'code-max-rl': 'k-max', 'code-pro-rl': 'k-pro',
  }),
};

const request = new Request('https://gateway.example.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
  body: JSON.stringify({ model: 'Code-Ultra', messages: [{ role: 'user', content: 'continue the task' }] }),
});

const response = await worker.fetch(request, env, {});
const body = await response.json();
assert.equal(response.status, 503, 'all-transient compatible family exhaustion must remain retryable');
assert.match(body?.error?.message || '', /Transient failures exhausted the compatible-model failover plan/i);
assert.doesNotMatch(body?.error?.message || '', /Compatible model capacity is temporarily unavailable/i);
assert.doesNotMatch(body?.error?.message || '', /All attempted nodes failed/i);
assert.equal(response.headers.get('x-should-retry'), null);
const retryAfter = Number(response.headers.get('retry-after'));
assert.ok(Number.isFinite(retryAfter) && retryAfter >= 25 && retryAfter <= 30);
assert.equal(body?.error?.details?.failure_kinds?.rate_limit, 3);
assert.deepEqual(calls.map((c) => c.model), ['up-code-ultra', 'up-code-max', 'up-code-pro']);
console.log('family rate-limit retry test passed.');
