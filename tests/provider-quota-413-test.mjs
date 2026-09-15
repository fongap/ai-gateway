#!/usr/bin/env node
import assert from 'node:assert/strict';
import { classifyUpstreamStatus, KIND } from '../src/reliability/classify.ts';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(error?.stack || error);
  }
}

const env = { RATE_LIMIT_COOLDOWN_MS: '60000' };

await test('Groq ITPM-shaped 413 rotates as a node rate limit', () => {
  const body = JSON.stringify({
    error: {
      message: 'Request too large for model `qwen/qwen3.8-27b` in organization `org_redacted` service tier `on_demand` on input tokens per minute (ITPM): Limit 7000, Requested 7398, please reduce your message size and try again.',
    },
  });
  const result = classifyUpstreamStatus(413, new Headers(), env, Date.now(), body);
  assert.equal(result.kind, KIND.RATE_LIMIT);
  assert.equal(result.action, 'rotate');
  assert.equal(result.counted, false);
  assert.equal(result.cooldownMs, 60000);
});

await test('quota-shaped 413 honors Retry-After', () => {
  const now = Date.now();
  const result = classifyUpstreamStatus(
    413,
    new Headers({ 'retry-after': '3' }),
    env,
    now,
    '{"error":{"message":"TPM rate limit exceeded"}}',
  );
  assert.equal(result.kind, KIND.RATE_LIMIT);
  assert.equal(result.action, 'rotate');
  assert.equal(result.retryAfterMs, 3000);
  assert.equal(result.cooldownMs, 3000);
  assert.equal(result.explicitRetryAfter, true);
});

await test('ordinary payload-size 413 remains a client stop', () => {
  const result = classifyUpstreamStatus(
    413,
    new Headers(),
    env,
    Date.now(),
    '{"error":{"message":"Request body exceeds the maximum payload size of 4 MB"}}',
  );
  assert.equal(result.kind, KIND.CLIENT);
  assert.equal(result.action, 'stop');
  assert.equal(result.cooldownMs, 0);
});

await test('rate-limit wording on unrelated status does not broaden classification', () => {
  const result = classifyUpstreamStatus(
    400,
    new Headers(),
    env,
    Date.now(),
    '{"error":{"message":"rate limit metadata is invalid"}}',
  );
  assert.equal(result.kind, KIND.CLIENT);
  assert.equal(result.action, 'stop');
});

console.log(`\nprovider-quota-413-test: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
