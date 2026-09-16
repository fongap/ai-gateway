#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  isOpenAIChatCompletionMeaningful,
  isOpenAIResponsesObjectMeaningful,
} from '../src/transport/openai.ts';
import { isAnthropicMessageMeaningful } from '../src/transport/anthropic.ts';
import { classifyUpstreamStatus } from '../src/reliability/classify.ts';
import { collectOpenAIStreamObject } from '../src/stream/assemble.ts';
import { collectAnthropicMessageObject } from '../src/stream/anthropic-native.ts';
import { createOpenAIChatStreamFromAnthropic } from '../src/conversion/anthropic-stream-to-openai-chat.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const encoder = new TextEncoder();
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`FAIL: ${name}`); console.error(e?.stack || e); }
}

function fakeSseResponse(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

function fakeHangingSseResponse(chunks) {
  let i = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (i < chunks.length) { controller.enqueue(encoder.encode(chunks[i++])); return; }
      return new Promise(() => {});
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

await test('safeReadErrorBody respects absolute deadline', async () => {
  const { safeReadErrorBody } = await import('../src/protocol/http.ts');
  const hanging = new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
  const start = Date.now();
  assert.equal(await safeReadErrorBody(hanging, 4096, Date.now() + 100), '');
  assert.ok(Date.now() - start < 500);
});

await test('OpenAI stream completes on finish_reason without HTTP EOF', async () => {
  const response = fakeHangingSseResponse([
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
  ]);
  const start = Date.now();
  const result = await collectOpenAIStreamObject(response, null, Date.now() + 30_000);
  assert.equal(result.id, 'c1');
  assert.ok(Date.now() - start < 1000);
});

await test('Anthropic stream completes on message_stop without HTTP EOF', async () => {
  const response = fakeHangingSseResponse([
    'data: {"type":"message_start","message":{"id":"m1","model":"claude","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ]);
  const start = Date.now();
  const result = await collectAnthropicMessageObject(response, null, Date.now() + 30_000);
  assert.equal(result.id, 'm1');
  assert.ok(Date.now() - start < 1000);
});

await test('Responses stream completes on response.completed', async () => {
  const { collectResponsesObject } = await import('../src/protocol/responses/native-stream.ts');
  const response = fakeSseResponse([
    'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}}\n\n',
  ]);
  assert.equal((await collectResponsesObject(response, null, null)).id, 'r1');
});

await test('Anthropic to OpenAI conversion ignores thinking content', async () => {
  const events = [
    { type: 'message_start', message: { id: 'm2', model: 'claude', usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hidden' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'visible' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')));
      controller.close();
    },
  });
  const reader = createOpenAIChatStreamFromAnthropic(source, { messageId: 'm2', model: 'claude' }).getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; out += decoder.decode(value); }
  assert.ok(out.includes('visible'));
  assert.ok(!out.includes('hidden'));
  assert.ok(out.includes('[DONE]'));
});

await test('meaningful-output guards accept valid refusal/reasoning/tool output', () => {
  assert.equal(isOpenAIChatCompletionMeaningful({ choices: [{ message: { role: 'assistant', refusal: 'no' } }] }), true);
  assert.equal(isOpenAIChatCompletionMeaningful({ choices: [{ message: { role: 'assistant', reasoning_content: 'think' } }] }), true);
  assert.equal(isOpenAIChatCompletionMeaningful({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: '1' }] } }] }), true);
  assert.equal(isOpenAIResponsesObjectMeaningful({ output: [{ type: 'refusal', refusal: 'no' }] }), true);
  assert.equal(isAnthropicMessageMeaningful({ content: [{ type: 'thinking', thinking: 'x' }] }), true);
});

await test('meaningful-output guards reject empty protocol objects', () => {
  assert.equal(isOpenAIChatCompletionMeaningful({ choices: [] }), false);
  assert.equal(isOpenAIResponsesObjectMeaningful({ output: [] }), false);
  assert.equal(isAnthropicMessageMeaningful({ content: [] }), false);
});

await test('409 stops while 408 rotates', () => {
  assert.equal(classifyUpstreamStatus(409, new Headers(), {}).action, 'stop');
  assert.equal(classifyUpstreamStatus(408, new Headers(), {}).action, 'rotate');
});

await test('real upstream SSE is not wrapped again by client lifecycle tracking', async () => {
  const { trackClientResponse } = await import('../src/observability/gateway-stats.ts');
  const body = new ReadableStream({ start(c) { c.close(); } });
  const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  assert.equal(trackClientResponse(response).body, response.body);
});

await test('model-status evidence uses successful requests, not usage reports', () => {
  const src = readFileSync(join(root, 'src', 'observability', 'token-usage-store', 'queries.ts'), 'utf8');
  const start = src.indexOf('export async function queryRecentModelEvidence');
  const end = src.indexOf('export async function queryAllModelsTtftPercentiles', start);
  assert.ok(start >= 0 && end > start, 'queryRecentModelEvidence function block must be present');
  const section = src.slice(start, end);
  assert.ok(section.includes('requests > 0'));
  assert.ok(!section.includes('usage_reports > 0'));
});

await test('key RPM snapshot keeps configured cap', async () => {
  const { admitKeyRequest, getKeyRpmSnapshot, __resetKeyRpmForTests } = await import('../src/ratelimit/key-rpm.ts');
  __resetKeyRpmForTests();
  admitKeyRequest('test-key', 50, Date.now());
  assert.deepEqual(getKeyRpmSnapshot('test-key', Date.now()), { cap: 50, used: 1 });
});

await test('local diagnostic/model routes are exempt from key RPM', () => {
  const src = readFileSync(join(root, 'src', 'request', 'preflight.ts'), 'utf8');
  const block = src.slice(src.indexOf("if (route !== 'health'"), src.indexOf("const diag ="));
  assert.ok(block.includes("route !== 'health'"));
  assert.ok(block.includes("route !== 'metrics'"));
  assert.ok(block.includes("route !== 'models'"));
  assert.ok(block.includes("route !== 'anthropic_count_tokens'"));
});

await test('top-level errors remain route-aware', async () => {
  const { sanitizedInternalErrorForRoute } = await import('../src/observability/diagnostic-endpoints.ts');
  const req = new Request('https://example.com/v1/responses');
  const anthropic = await sanitizedInternalErrorForRoute(req, {}, 'anthropic_messages', 'r1').json();
  const responses = await sanitizedInternalErrorForRoute(req, {}, 'openai_responses', 'r2').json();
  assert.equal(anthropic.type, 'error');
  assert.equal(responses.error.type, 'server_error');
});

await test('Tier 1 explicit maxInFlight is enforced', async () => {
  const { isTier1Eligible, __resetTier1StateForTests, claimTier1Slot, releaseTier1Slot, makeTier1ReleaseToken } = await import('../src/reliability/tier1-state.ts');
  __resetTier1StateForTests();
  const node = {
    id: 'cap-test', tier: 'tier-1', provider: 'test', protocol: 'openai',
    surfaces: ['chat'], models: { m: 'up-m' },
  };
  const req = { protocol: 'openai', surface: 'chat', model: 'm' };
  for (let i = 0; i < 4; i++) assert.equal(claimTier1Slot(node, Date.now(), 'm', 4), true);
  assert.equal(claimTier1Slot(node, Date.now(), 'm', 4), false);
  assert.equal(isTier1Eligible(node, req, Date.now(), new Set(['m']), 4), false);
  releaseTier1Slot(node.id, makeTier1ReleaseToken(node.id));
  assert.equal(isTier1Eligible(node, req, Date.now(), new Set(['m']), 4), true);
});

await test('token attribution uses resolved upstream model', () => {
  const src = readFileSync(join(root, 'src', 'request', 'attempt', 'observability.ts'), 'utf8');
  assert.ok(src.includes('upstreamModelOf(node, c.requestedModel)'));
});

await test('Tier 1 score keeps bounded request priority', async () => {
  const { calculateTier1Score, __resetTier1StateForTests } = await import('../src/reliability/tier1-state.ts');
  __resetTier1StateForTests();
  const node = { id: 'p-test', tier: 'tier-1', protocol: 'openai', surfaces: ['chat'], models: {}, provider: 'test' };
  const normal = calculateTier1Score(node, 'm', [node], 1, Date.now());
  const high = calculateTier1Score(node, 'm', [node], 1, Date.now(), 5);
  const low = calculateTier1Score(node, 'm', [node], 1, Date.now(), 1);
  assert.ok(high < normal);
  assert.ok(low > normal);
});

console.log(`\nreliability-regression-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
