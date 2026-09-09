#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio

import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { convertAnthropicToOpenAIRequest } from '../src/conversion/anthropic-to-openai.ts';
import { __resetAllStateForTests } from '../src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '../src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.ts';

const ACCESS_KEY = 'test-access-key';
const PRIVATE_TEXT = 'PRIVATE_PROMPT_DO_NOT_LOG';

__resetAllStateForTests();
__resetTier1StateForTests();
__resetTier1AffinityForTests();

const structuredSchema = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['answer'],
  additionalProperties: false,
};
const structured = convertAnthropicToOpenAIRequest({
  model: 'code-max',
  max_tokens: 1024,
  output_config: {
    effort: 'high',
    format: { type: 'json_schema', schema: structuredSchema },
  },
  messages: [{ role: 'user', content: 'answer the question' }],
});
assert.equal(structured.messages[0].role, 'system');
assert.match(structured.messages[0].content, /final assistant text response/);
assert.ok(structured.messages[0].content.includes(JSON.stringify(structuredSchema)));
assert.deepEqual(structured.messages[1], { role: 'user', content: 'answer the question' });
assert.equal(Object.hasOwn(structured, 'output_config'), false);

let upstreamCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  upstreamCalls++;
  throw new Error('upstream must not be called when conversion is rejected');
};

const logs = [];
const originalError = console.error;
console.error = (...args) => logs.push(args.map((arg) => String(arg)).join(' '));

try {
  const env = {
    GATEWAY_ACCESS_KEY_AIR: ACCESS_KEY,
    GATEWAY_ACCESS_MODELS_AIR: '*',
    PROTOCOL_FALLBACKS: JSON.stringify({
      'anthropic:messages': ['openai:chat_completions'],
    }),
    TIER1_NODES_CONFIG_01: JSON.stringify([
      {
        id: 'openai-only',
        provider: 'mock',
        protocol: 'openai',
        surfaces: ['chat_completions'],
        base_url: 'https://openai-only.example.com/v1',
        models: { 'code-max': 'up-model' },
        limits: { concurrency: 5 },
      },
    ]),
    TIER1_NODES_SECRETS_01: JSON.stringify({ 'openai-only': 'upstream-key' }),
  };

  const request = new Request('https://gateway.example.com/v1/messages?beta=true', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ACCESS_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'code-max',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'thinking', thinking: PRIVATE_TEXT },
            { type: 'text', text: 'hello' },
          ],
        },
      ],
    }),
  });

  const response = await worker.fetch(request, env, {});
  assert.equal(response.status, 502,
    'pre-dispatch conversion incompatibility must be reported as 502, not cooldown 429');
  assert.equal(upstreamCalls, 0, 'conversion failure must not dispatch upstream');

  const body = await response.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.message, 'Configured protocol fallback cannot represent this request.');
  assert.equal(body.error.details.failure_kind, 'conversion_not_supported');
  assert.equal(body.error.details.dispatches, 0);

  const recordLine = logs.find((line) => line.includes('fallback_conversion_skipped'));
  assert.ok(recordLine, 'conversion rejection must emit a searchable diagnostic');
  const record = JSON.parse(recordLine);
  assert.equal(record.event, 'fallback_conversion_skipped');
  assert.equal(record.route, 'anthropic_messages');
  assert.equal(record.fallback_protocol, 'openai');
  assert.equal(record.fallback_surface, 'chat_completions');
  assert.match(record.reason, /conversion_not_supported: user content\.thinking/);
  assert.equal(record.request_id, response.headers.get('request-id'));

  const joinedLogs = logs.join('\n');
  assert.equal(joinedLogs.includes(PRIVATE_TEXT), false, 'request content must never be logged');
  assert.equal(joinedLogs.includes(ACCESS_KEY), false, 'gateway credential must never be logged');
  assert.equal(joinedLogs.includes('upstream-key'), false, 'upstream credential must never be logged');

  console.log('fallback conversion observability test passed');
} finally {
  console.error = originalError;
  globalThis.fetch = originalFetch;
}
