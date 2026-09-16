#!/usr/bin/env node
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { classifyUpstreamStatus, KIND } from '../src/reliability/classify.ts';
import { __resetAllStateForTests } from '../src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '../src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.ts';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (error) { failed++; console.error(`FAIL - ${name}`); console.error(error?.stack || error); }
}

const env = { RATE_LIMIT_COOLDOWN_MS: '60000' };

await test('Groq ITPM-shaped 413 rotates as a node rate limit', () => {
  const body = JSON.stringify({ error: { message: 'Request too large on input tokens per minute (ITPM): Limit 7000, Requested 7398.' } });
  const result = classifyUpstreamStatus(413, new Headers(), env, Date.now(), body);
  assert.equal(result.kind, KIND.RATE_LIMIT);
  assert.equal(result.action, 'rotate');
  assert.equal(result.cooldownMs, 60000);
});

await test('quota-shaped 413 honors Retry-After', () => {
  const result = classifyUpstreamStatus(413, new Headers({ 'retry-after': '3' }), env, Date.now(), '{"error":{"message":"TPM rate limit exceeded"}}');
  assert.equal(result.kind, KIND.RATE_LIMIT);
  assert.equal(result.retryAfterMs, 3000);
  assert.equal(result.cooldownMs, 3000);
  assert.equal(result.explicitRetryAfter, true);
});

await test('ordinary payload-size 413 remains a client stop', () => {
  const result = classifyUpstreamStatus(413, new Headers(), env, Date.now(), '{"error":{"message":"Request body exceeds the maximum payload size of 4 MB"}}');
  assert.equal(result.kind, KIND.CLIENT);
  assert.equal(result.action, 'stop');
});

await test('real request continues after Tier 1 quota-413', async () => {
  __resetAllStateForTests();
  __resetTier1StateForTests();
  __resetTier1AffinityForTests();
  const accessKey = 'quota-413-integration-key';
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    calls.push(url.hostname);
    if (url.hostname === 'groq-quota.example.com') {
      return new Response(JSON.stringify({ error: { message: 'input tokens per minute (ITPM): Limit 7000, Requested 7398' } }), {
        status: 413, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.hostname === 'fallback.example.com') {
      const requestBody = init?.body ? JSON.parse(init.body) : {};
      return Response.json({
        id: 'chatcmpl-quota-fallback', object: 'chat.completion', model: requestBody.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'fallback ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7398, completion_tokens: 2, total_tokens: 7400 },
      });
    }
    throw new Error(`unexpected host ${url.hostname}`);
  };

  try {
    const integrationEnv = {
      GATEWAY_ACCESS_KEY_PRO: accessKey,
      GATEWAY_ACCESS_MODELS_PRO: '*',
      PROTOCOL_FALLBACKS: 'disable',
      HEDGE_DELAY_MS: '0',
      MAX_HEDGES_PER_REQUEST: '0',
      RATE_LIMIT_COOLDOWN_MS: '60000',
      TIER1_NODES_CONFIG_01: JSON.stringify([{
        id: 'groq-quota', provider: 'groq',
        base_url: 'https://groq-quota.example.com/v1', priority: 10, models: { 'Quota-Test': 'qwen/qwen3.8-27b' },
      }]),
      TIER1_NODES_SECRETS_01: JSON.stringify({ 'groq-quota': 'groq-key' }),
      TIER2_NODES_CONFIG_01: JSON.stringify([{
        id: 'fallback-node', provider: 'fallback-provider',
        base_url: 'https://fallback.example.com/v1', priority: 10, models: { 'Quota-Test': 'fallback-model' },
      }]),
      TIER2_NODES_SECRETS_01: JSON.stringify({ 'fallback-node': 'fallback-key' }),
      POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 2 } }),
    };
    const response = await worker.fetch(new Request('https://gateway.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessKey}` },
      body: JSON.stringify({ model: 'Quota-Test', messages: [{ role: 'user', content: 'large context' }] }),
    }), integrationEnv, {});
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body?.choices?.[0]?.message?.content, 'fallback ok');
    assert.deepEqual(calls, ['groq-quota.example.com', 'fallback.example.com']);
  } finally { globalThis.fetch = originalFetch; }
});

console.log(`\nprovider-quota-413-test: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
