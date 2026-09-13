#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Cross-module invariants for the v1.3.5 reliability convergence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.ts';
import { loadPoliciesConfig } from '../src/config/policies.ts';
import { __resetAllStateForTests } from '../src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '../src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.ts';

function reset() {
  __resetAllStateForTests();
  __resetTier1StateForTests();
  __resetTier1AffinityForTests();
}

function chatCompletion(model, content = 'ok') {
  return new Response(JSON.stringify({
    id: 'chatcmpl-test', object: 'chat.completion', model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function request(model, key) {
  return new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'test' }] }),
  });
}

function node(id, model, upstreamModel = `up-${model.toLowerCase()}`) {
  return {
    id, provider: id.split('-')[0], protocol: 'openai', surfaces: ['chat_completions'],
    base_url: `https://${id}.example.com/v1`, priority: 10,
    models: { [model]: upstreamModel },
  };
}

// Internal family fallback must remain inside the current Gateway Key's model
// scope. An AIR key may request Air, but it must not silently consume Pro/Max.
{
  reset();
  const key = 'air-only-key';
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const body = JSON.parse(init.body);
    calls.push({ host: url.hostname, model: body.model });
    if (url.hostname.startsWith('air-')) {
      return new Response(JSON.stringify({ error: { message: 'temporary unavailable' } }), {
        status: 503, headers: { 'content-type': 'application/json' },
      });
    }
    return chatCompletion(body.model, 'should-not-be-called');
  };
  const env = {
    GATEWAY_ACCESS_KEY_AIR: key,
    GATEWAY_ACCESS_MODELS_AIR: 'Air,SenseNova',
    PROTOCOL_FALLBACKS: 'disable',
    TIER1_NODES_CONFIG_01: JSON.stringify([
      node('air-01', 'Air', 'up-air'),
      node('pro-01', 'Pro', 'up-pro'),
      node('max-01', 'Max', 'up-max'),
    ]),
    TIER1_NODES_SECRETS_01: JSON.stringify({ 'air-01': 'a', 'pro-01': 'p', 'max-01': 'm' }),
  };
  const response = await worker.fetch(request('Air', key), env, {});
  assert.notEqual(response.status, 200, 'Air failure must not be hidden by an unauthorized higher model');
  assert.deepEqual(calls.map((c) => c.model), ['up-air'], 'family fallback must be intersected with key scope');
}

// model_missing is a (node, model) fact. It may cool that mapping, but must not
// stop a compatible sibling model from serving the request.
{
  reset();
  const key = 'family-key';
  const calls = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    if (body.model === 'up-max') {
      return new Response(JSON.stringify({ error: { message: 'model not found' } }), {
        status: 404, headers: { 'content-type': 'application/json' },
      });
    }
    return chatCompletion(body.model, 'fallback-ok');
  };
  const env = {
    GATEWAY_ACCESS_KEY_MAX: key,
    GATEWAY_ACCESS_MODELS_MAX: 'Max,Pro,Ultra',
    PROTOCOL_FALLBACKS: 'disable',
    TIER1_NODES_CONFIG_01: JSON.stringify([
      node('max-01', 'Max', 'up-max'),
      node('pro-01', 'Pro', 'up-pro'),
    ]),
    TIER1_NODES_SECRETS_01: JSON.stringify({ 'max-01': 'm', 'pro-01': 'p' }),
  };
  const response = await worker.fetch(request('Max', key), env, {});
  assert.equal(response.status, 200, 'a sibling model must remain eligible after one mapping 404');
  const body = await response.json();
  assert.equal(body.model, 'Max', 'transparent family fallback preserves client model identity');
  assert.deepEqual(calls, ['up-max', 'up-pro']);
}

// A hedge object is opt-in by presence; enabled:false is the only disable.
{
  const policies = loadPoliciesConfig({
    FAILOVER_BUDGET_MS: '60000',
    POLICIES_CONFIG: JSON.stringify({
      custom: { max_attempts: 2, hedge: { delay_ms: 1500, tiers: ['tier1'] } },
      disabled: { max_attempts: 2, hedge: { enabled: false, delay_ms: 1500, tiers: ['tier1'] } },
    }),
  });
  assert.equal(policies.custom.hedge?.enabled, true);
  assert.equal(policies.custom.hedge?.delayMs, 1500);
  assert.equal(policies.disabled.hedge?.enabled, false);
}

// Tier 1 429 duration has exactly one owner. adaptive-429.ts computes the
// provider+key cooldown; tier1-state.ts stores that supplied duration and owns
// only recovery-state transitions. This prevents a second 30/45/60 ladder from
// silently diverging from the adaptive ladder.
{
  const tier1StateSource = readFileSync(new URL('../src/reliability/tier1-state.ts', import.meta.url), 'utf8');
  const outcomeSource = readFileSync(new URL('../src/request/attempt/outcome.ts', import.meta.url), 'utf8');
  for (const retired of ['TIER1_429_BASE_MS', 'TIER1_429_SECOND_MS', 'TIER1_429_MAX_MS', 'rateLimitCooldownMs']) {
    assert.equal(tier1StateSource.includes(retired), false, `tier1-state must not retain retired 429 duration owner ${retired}`);
  }
  assert.match(
    tier1StateSource,
    /outcome\.backoff === 'rate_limit'\) return Math\.max\(0, outcome\.cooldownMs \?\? 0\)/,
    'tier1-state must consume the supplied adaptive 429 duration directly',
  );
  assert.match(outcomeSource, /nextAdaptive429CooldownMs\(/,
    'request outcome handling must resolve adaptive 429 cooldown before Tier 1 state update');
  assert.match(outcomeSource, /snapshotAdaptive429State\(/,
    '429 observability must read the same adaptive state that owns cooldown duration');
  assert.match(outcomeSource, /rate_limit_stage=/,
    'Tier 1 429 dispatch logs must expose adaptive recovery stage for production validation');
}

console.log('reliability convergence invariants passed.');