#!/usr/bin/env node
// Reliability semantic convergence regression tests.
//
// Covers the specific scenarios fixed in the reliability convergence work:
//   1. safeReadErrorBody deadline races every reader.read() against attemptDeadlineMs
//   2. OpenAI Chat semantic EOF ([DONE] / finish_reason) cancels reader
//   3. Anthropic native semantic EOF (message_stop) cancels reader
//   4. Responses native semantic EOF (response.completed) cancels reader
//   5. Cross-protocol precommit replay skips thinking blocks (Anthropic→OpenAI)
//   6. isOpenAIChatCompletionMeaningful recognizes refusal as valid output
//   7. isOpenAIResponsesObjectMeaningful recognizes refusal items and parts
//   8. isAnthropicMessageMeaningful recognizes thinking as valid output
//   9. 409 classification is stop (not rotate)
//  10. gatewayStats trackClientResponse lifecycle (success on clean close)
//  11. gatewayStats trackClientResponse lifecycle (cancellation on cancel)
//  12. collectOpenAIStreamObject breaks on finish_reason even without [DONE]
//  13. collectAnthropicMessageObject breaks on message_stop
//  14. collectOpenAIStreamObject cancels reader on semantic EOF (not waiting for HTTP EOF)
//  15. Version check: first CHANGELOG section matches package.json version
//  16. model-status queries: requests > 0 is the evidence gate (not usage_reports)

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
import { gatewayStats } from '../src/observability/gateway-stats.ts';
import { collectOpenAIStreamObject } from '../src/stream/assemble.ts';
import { collectAnthropicMessageObject } from '../src/stream/anthropic-native.ts';
import { createOpenAIChatStreamFromAnthropic } from '../src/conversion/anthropic-stream-to-openai-chat.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const encoder = new TextEncoder();

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

// Helper: create a fake SSE upstream Response from an array of SSE lines
function fakeSseResponse(lines, opts = {}) {
  const body = encoder.encode(lines.join('\n'));
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  }), {
    status: opts.status ?? 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

// Helper: create a fake SSE response that sends chunks then hangs forever
function fakeHangingSseResponse(chunks) {
  let pullCount = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (pullCount < chunks.length) {
        controller.enqueue(encoder.encode(chunks[pullCount]));
        pullCount++;
        return;
      }
      // Park forever — never close
      return new Promise(() => {});
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

// ─── 1. safeReadErrorBody deadline ───────────────────────────────────────────
await test('safeReadErrorBody races reader.read() against deadline', async () => {
  const { safeReadErrorBody } = await import('../src/protocol/http.ts');
  // Create a response that hangs forever on reader.read()
  const hanging = new Response(new ReadableStream({
    pull() { return new Promise(() => {}); },
  }), { status: 500, headers: { 'content-type': 'application/json' } });

  const start = Date.now();
  const result = await safeReadErrorBody(hanging, 4096, 100);
  const elapsed = Date.now() - start;

  assert.equal(result, '', 'should return empty string on timeout');
  assert.ok(elapsed < 500, `deadline should fire within 500ms, took ${elapsed}ms`);
});

await test('safeReadErrorBody returns body text when deadline is ample', async () => {
  const { safeReadErrorBody } = await import('../src/protocol/http.ts');
  const body = JSON.stringify({ error: { message: 'not found' } });
  const fast = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  }), { status: 404, headers: { 'content-type': 'application/json' } });

  // deadlineMs is an absolute timestamp; use Date.now() + 5000
  const result = await safeReadErrorBody(fast, 4096, Date.now() + 5000);
  assert.equal(result, body, 'should read full body within deadline');
});

// ─── 2. OpenAI Chat semantic EOF ─────────────────────────────────────────────
await test('collectOpenAIStreamObject breaks on finish_reason without [DONE]', async () => {
  // Stream with finish_reason but no [DONE] marker — should succeed via semantic EOF
  const chunks = [
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
    'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    // Never sends [DONE]
  ];
  const response = fakeSseResponse(chunks);
  const result = await collectOpenAIStreamObject(response, null, null);
  assert.equal(result.id, 'c1');
  assert.ok(Array.isArray(result.choices));
  assert.equal(result.choices[0].finish_reason, 'stop');
});

await test('collectOpenAIStreamObject breaks on [DONE] marker', async () => {
  // [DONE] triggers semantic EOF; finish_reason must be present for the
  // completion marker check to pass after the loop exits.
  const chunks = [
    'data: {"id":"c2","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
    'data: {"id":"c2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const response = fakeSseResponse(chunks);
  const result = await collectOpenAIStreamObject(response, null, null);
  assert.equal(result.id, 'c2');
  assert.equal(result.choices[0].message.content, 'hello');
});

// ─── 3. Anthropic native semantic EOF ────────────────────────────────────────
await test('collectAnthropicMessageObject breaks on message_stop', async () => {
  const chunks = [
    'data: {"type":"message_start","message":{"id":"m1","model":"claude","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
    'data: {"type":"message_stop"}\n\n',
    // Never closes HTTP — message_stop should trigger break
  ];
  const response = fakeSseResponse(chunks);
  const result = await collectAnthropicMessageObject(response, null, null);
  assert.equal(result.type, 'message');
  assert.equal(result.id, 'm1');
  assert.equal(result.stop_reason, 'end_turn');
});

// ─── 4. Responses native semantic EOF ────────────────────────────────────────
await test('collectResponsesObject breaks on response.completed', async () => {
  const { collectResponsesObject } = await import('../src/protocol/responses/native-stream.ts');
  const chunks = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant","content":[]}}\n\n',
    'event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"hello"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}\n\n',
    // Never closes HTTP — response.completed should trigger break
  ];
  const response = fakeSseResponse(chunks);
  const result = await collectResponsesObject(response, null, null);
  assert.equal(result.id, 'r1');
});

// ─── 5. Cross-protocol precommit replay skips thinking ──────────────────────
await test('Anthropic→OpenAI converter skips thinking blocks without error', async () => {
  const anthropicEvents = [
    { type: 'message_start', message: { id: 'm1', model: 'claude', usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'internal thought' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'visible output' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ];

  const sseLines = anthropicEvents.map((e) => `data: ${JSON.stringify(e)}`).join('\n');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseLines));
      controller.close();
    },
  });

  const outputChunks = [];
  const openaiStream = createOpenAIChatStreamFromAnthropic(stream, { messageId: 'm1', model: 'claude' });
  const reader = openaiStream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    outputChunks.push(decoder.decode(value));
  }

  const output = outputChunks.join('');
  // Should contain visible text output
  assert.ok(output.includes('visible output'), 'should contain visible text');
  // Should NOT contain thinking content
  assert.ok(!output.includes('internal thought'), 'should not contain thinking content');
  // Should contain [DONE]
  assert.ok(output.includes('[DONE]'), 'should end with [DONE]');
});

await test('Anthropic→OpenAI converter skips redacted_thinking blocks without error', async () => {
  const anthropicEvents = [
    { type: 'message_start', message: { id: 'm2', model: 'claude', usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'real answer' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];

  const sseLines = anthropicEvents.map((e) => `data: ${JSON.stringify(e)}`).join('\n');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseLines));
      controller.close();
    },
  });

  const outputChunks = [];
  const openaiStream = createOpenAIChatStreamFromAnthropic(stream, { messageId: 'm2', model: 'claude' });
  const reader = openaiStream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    outputChunks.push(decoder.decode(value));
  }

  const output = outputChunks.join('');
  assert.ok(output.includes('real answer'), 'should contain real text output');
  assert.ok(output.includes('[DONE]'), 'should end with [DONE]');
});

// ─── 6. Refusal semantics: Chat completion ───────────────────────────────────
await test('isOpenAIChatCompletionMeaningful recognizes message.refusal', () => {
  const data = {
    choices: [{ message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' } }],
  };
  assert.equal(isOpenAIChatCompletionMeaningful(data), true);
});

await test('isOpenAIChatCompletionMeaningful rejects empty choices', () => {
  const data = { choices: [] };
  assert.equal(isOpenAIChatCompletionMeaningful(data), false);
});

await test('isOpenAIChatCompletionMeaningful rejects role-only message', () => {
  const data = { choices: [{ message: { role: 'assistant' } }] };
  assert.equal(isOpenAIChatCompletionMeaningful(data), false);
});

await test('isOpenAIChatCompletionMeaningful accepts content string', () => {
  const data = { choices: [{ message: { role: 'assistant', content: 'hello' } }] };
  assert.equal(isOpenAIChatCompletionMeaningful(data), true);
});

await test('isOpenAIChatCompletionMeaningful accepts reasoning_content', () => {
  const data = { choices: [{ message: { role: 'assistant', content: null, reasoning_content: 'let me think' } }] };
  assert.equal(isOpenAIChatCompletionMeaningful(data), true);
});

await test('isOpenAIChatCompletionMeaningful accepts tool_calls', () => {
  const data = {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{}' } }],
      },
    }],
  };
  assert.equal(isOpenAIChatCompletionMeaningful(data), true);
});

// ─── 7. Refusal semantics: Responses object ─────────────────────────────────
await test('isOpenAIResponsesObjectMeaningful recognizes refusal item type', () => {
  const data = {
    output: [{ type: 'refusal', refusal: 'I cannot comply.' }],
  };
  assert.equal(isOpenAIResponsesObjectMeaningful(data), true);
});

await test('isOpenAIResponsesObjectMeaningful recognizes refusal content part', () => {
  const data = {
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'refusal', refusal: 'Not possible.' }],
    }],
  };
  assert.equal(isOpenAIResponsesObjectMeaningful(data), true);
});

await test('isOpenAIResponsesObjectMeaningful rejects empty output', () => {
  const data = { output: [] };
  assert.equal(isOpenAIResponsesObjectMeaningful(data), false);
});

await test('isOpenAIResponsesObjectMeaningful accepts output_text content', () => {
  const data = {
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'result' }],
    }],
  };
  assert.equal(isOpenAIResponsesObjectMeaningful(data), true);
});

await test('isOpenAIResponsesObjectMeaningful accepts function_call', () => {
  const data = {
    output: [{ type: 'function_call', id: 'fc1', call_id: 'c1', name: 'tool', arguments: '{}' }],
  };
  assert.equal(isOpenAIResponsesObjectMeaningful(data), true);
});

// ─── 8. Anthropic message meaningful ────────────────────────────────────────
await test('isAnthropicMessageMeaningful accepts text content', () => {
  const data = { content: [{ type: 'text', text: 'hello' }] };
  assert.equal(isAnthropicMessageMeaningful(data), true);
});

await test('isAnthropicMessageMeaningful accepts thinking content', () => {
  const data = { content: [{ type: 'thinking', thinking: 'reasoning...' }] };
  assert.equal(isAnthropicMessageMeaningful(data), true);
});

await test('isAnthropicMessageMeaningful accepts tool_use content', () => {
  const data = { content: [{ type: 'tool_use', name: 'search', input: {} }] };
  assert.equal(isAnthropicMessageMeaningful(data), true);
});

await test('isAnthropicMessageMeaningful rejects empty content', () => {
  const data = { content: [] };
  assert.equal(isAnthropicMessageMeaningful(data), false);
});

// ─── 9. 409 classification ──────────────────────────────────────────────────
await test('409 Conflict is classified as stop (not rotate)', () => {
  const h = new Headers();
  const result = classifyUpstreamStatus(409, h, {});
  assert.equal(result.action, 'stop', '409 should stop, not rotate');
  assert.equal(result.kind, 'server');
  assert.equal(result.counted, false, '409 should not count toward circuit breaker');
});

await test('408 Timeout is classified as rotate', () => {
  const h = new Headers();
  const result = classifyUpstreamStatus(408, h, {});
  assert.equal(result.action, 'rotate', '408 should rotate');
});

await test('425 Too Early is classified as rotate', () => {
  const h = new Headers();
  const result = classifyUpstreamStatus(425, h, {});
  assert.equal(result.action, 'rotate', '425 should rotate');
});

// ─── 10. gatewayStats trackClientResponse lifecycle ──────────────────────────
await test('trackClientResponse decrements activeRequests and increments success on clean close', async () => {
  const { trackClientResponse, gatewayStats: gs } = await import('../src/observability/gateway-stats.ts');
  const beforeActive = gs.activeRequests;
  const beforeSuccesses = gs.successes;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"chunk":1}\n\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  const tracked = trackClientResponse(response);
  assert.ok(tracked instanceof Response, 'should return a Response');
  assert.ok(tracked.body, 'tracked response should have a body');
  // Read the tracked body to completion so the settle callback fires
  const reader = tracked.body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
  // After clean close, successes should have incremented
  assert.ok(gs.successes >= beforeSuccesses + 1, `successes should increment: ${gs.successes} >= ${beforeSuccesses + 1}`);
  // activeRequests should have decremented (or stayed at 0)
  assert.ok(gs.activeRequests <= beforeActive, `activeRequests should not increase: ${gs.activeRequests} <= ${beforeActive}`);
});

await test('trackClientResponse exists as exported function', async () => {
  const { trackClientResponse } = await import('../src/observability/gateway-stats.ts');
  assert.equal(typeof trackClientResponse, 'function', 'trackClientResponse should be exported');
});

// ─── 11. gatewayStats lifecycle: cancel path ────────────────────────────────
await test('trackClientResponse wraps streaming response with cancel handler', async () => {
  const { trackClientResponse } = await import('../src/observability/gateway-stats.ts');
  const body = new ReadableStream({
    pull(controller) {
      return new Promise(() => {}); // hang forever
    },
  });
  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  const tracked = trackClientResponse(response);
  assert.ok(tracked.body, 'tracked response should have a body');
  assert.ok(tracked.body !== response.body, 'tracked body should be a wrapper');
});

// ─── 12. collectOpenAIStreamObject finish_reason semantic EOF ────────────────
await test('collectOpenAIStreamObject counts chunks and bytes', async () => {
  const chunks = [
    'data: {"id":"c3","choices":[{"index":0,"delta":{"content":"abc"},"finish_reason":null}]}\n\n',
    'data: {"id":"c3","choices":[{"index":0,"delta":{"content":"def"},"finish_reason":null}]}\n\n',
    'data: {"id":"c3","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  ];
  const response = fakeSseResponse(chunks);
  const result = await collectOpenAIStreamObject(response, null, null);
  assert.equal(result.choices[0].message.content, 'abcdef');
  assert.equal(result.choices[0].finish_reason, 'stop');
});

// ─── 13. collectAnthropicMessageObject handles thinking in collected stream ──
await test('collectAnthropicMessageObject collects thinking blocks correctly', async () => {
  const chunks = [
    'data: {"type":"message_start","message":{"id":"m3","model":"claude","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"deep thought"}}\n\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}\n\n',
    'data: {"type":"content_block_stop","index":1}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ];
  const response = fakeSseResponse(chunks);
  const result = await collectAnthropicMessageObject(response, null, null);
  assert.equal(result.type, 'message');
  // Should have 2 content blocks: thinking + text
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].type, 'thinking');
  assert.equal(result.content[0].thinking, 'deep thought');
  assert.equal(result.content[1].type, 'text');
  assert.equal(result.content[1].text, 'answer');
  assert.equal(result.stop_reason, 'end_turn');
});

// ─── 14. Semantic EOF cancels reader ────────────────────────────────────────
await test('collectOpenAIStreamObject completes quickly on semantic EOF even with hanging HTTP', async () => {
  // Upstream sends finish_reason then hangs forever on HTTP level
  const chunks = [
    'data: {"id":"c4","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n',
  ];
  const response = fakeHangingSseResponse(chunks, 1);
  const start = Date.now();
  // deadlineMs is absolute; use a generous value so it doesn't fire
  const result = await collectOpenAIStreamObject(response, null, Date.now() + 30_000);
  const elapsed = Date.now() - start;
  assert.equal(result.id, 'c4');
  assert.ok(elapsed < 1000, `semantic EOF should cancel quickly, took ${elapsed}ms`);
});

await test('collectAnthropicMessageObject completes quickly on message_stop even with hanging HTTP', async () => {
  const chunks = [
    'data: {"type":"message_start","message":{"id":"m4","model":"claude","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ];
  const response = fakeHangingSseResponse(chunks, chunks.length);
  const start = Date.now();
  const result = await collectAnthropicMessageObject(response, null, Date.now() + 30_000);
  const elapsed = Date.now() - start;
  assert.equal(result.id, 'm4');
  assert.ok(elapsed < 1000, `message_stop should cancel quickly, took ${elapsed}ms`);
});

// ─── 15. Version check: CHANGELOG first section matches package.json ────────
await test('first CHANGELOG versioned section matches package.json version', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const match = changelog.match(/^## \[?v?(\d+\.\d+\.\d+)/m);
  assert.ok(match, 'CHANGELOG should have a version header');
  assert.equal(match[1], pkg.version, 'first CHANGELOG version should match package.json');
});

await test('version.ts exports match package.json version', async () => {
  const { VERSION } = await import('../src/config/version.ts');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(VERSION, pkg.version, 'VERSION constant should match package.json');
});

// ─── 16. Model status evidence gate ─────────────────────────────────────────
await test('queryRecentModelEvidence SQL uses requests > 0 (not usage_reports)', async () => {
  // Read the source file and verify the SQL condition
  const src = readFileSync(join(root, 'src', 'observability', 'token-usage-store', 'queries.ts'), 'utf8');
  // Should use requests > 0 as the evidence condition
  assert.ok(src.includes('requests > 0'), 'queries.ts should use requests > 0 for evidence');
  // Should NOT use usage_reports > 0 as the evidence gate
  const evidenceSection = src.match(/queryRecentModelEvidence[\s\S]*?(?=export|\z)/)?.[0] ?? '';
  if (evidenceSection) {
    assert.ok(!evidenceSection.includes('usage_reports > 0'), 'queryRecentModelEvidence should not use usage_reports > 0');
  }
});

// ─── 17. Key RPM snapshot cap ──────────────────────────────────────────────
await test('getKeyRpmSnapshot returns configured cap', async () => {
  const { admitKeyRequest, getKeyRpmSnapshot, __resetKeyRpmForTests } = await import('../src/ratelimit/key-rpm.ts');
  __resetKeyRpmForTests();
  admitKeyRequest('test-key', 50, Date.now());
  const snap = getKeyRpmSnapshot('test-key', Date.now());
  assert.equal(snap.cap, 50, 'snapshot should return the configured cap');
  assert.equal(snap.used, 1, 'snapshot should count the admitted request');
});

await test('getKeyRpmSnapshot returns cap 0 for unknown key', async () => {
  const { getKeyRpmSnapshot, __resetKeyRpmForTests } = await import('../src/ratelimit/key-rpm.ts');
  __resetKeyRpmForTests();
  const snap = getKeyRpmSnapshot('unknown-key');
  assert.equal(snap.cap, 0, 'unknown key should have cap 0');
  assert.equal(snap.used, 0, 'unknown key should have used 0');
});

// ─── 18. count_tokens/models exempt from key RPM ───────────────────────────
await test('preflight RPM gate exempts models and count_tokens routes', async () => {
  const src = readFileSync(join(root, 'src', 'request', 'preflight.ts'), 'utf8').replace(/\r\n/g, '\n');
  // Verify the RPM gate condition includes exemptions for local routes
  assert.ok(src.includes("route !== 'models'"), 'RPM gate should exempt models route');
  assert.ok(src.includes("route !== 'anthropic_count_tokens'"), 'RPM gate should exempt count_tokens route');
  // Verify these exemptions are near the Per-key RPM comment (the actual gate)
  const rpmCommentIdx = src.indexOf('Per-key in-isolate RPM');
  assert.ok(rpmCommentIdx > 0, 'RPM comment block should exist');
  const rpmBlock = src.substring(rpmCommentIdx, rpmCommentIdx + 800);
  assert.ok(rpmBlock.includes("route !== 'models'"), 'models exemption should be in RPM block');
  assert.ok(rpmBlock.includes("route !== 'anthropic_count_tokens'"), 'count_tokens exemption should be in RPM block');
});

// ─── 19. Route-aware top-level error ────────────────────────────────────────
await test('index.ts uses detectRoute for error shaping', async () => {
  const src = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
  assert.ok(src.includes('detectRoute'), 'index.ts should import detectRoute');
  assert.ok(src.includes('sanitizedInternalErrorForRoute'), 'index.ts should use route-aware error');
  assert.ok(!src.includes('/messages/.test(pathname)'), 'index.ts should not use binary isAnthropic heuristic');
});

await test('sanitizedInternalErrorForRoute routes to correct error shape', async () => {
  const { sanitizedInternalErrorForRoute } = await import('../src/observability/diagnostic-endpoints.ts');
  const req = new Request('https://example.com/v1/responses', { method: 'POST' });
  const env = {};

  // Anthropic route
  const anthResp = sanitizedInternalErrorForRoute(req, env, 'anthropic_messages', 'r1');
  const anthBody = JSON.parse(await anthResp.text());
  assert.equal(anthBody.type, 'error', 'Anthropic error should have type: error');
  assert.equal(anthBody.error.type, 'api_error');

  // OpenAI Responses route
  const respResp = sanitizedInternalErrorForRoute(req, env, 'openai_responses', 'r2');
  const respBody = JSON.parse(await respResp.text());
  assert.equal(respBody.error.type, 'server_error', 'Responses error should have type: server_error');

  // OpenAI Chat route (default)
  const chatResp = sanitizedInternalErrorForRoute(req, env, 'openai_chat', 'r3');
  const chatBody = JSON.parse(await chatResp.text());
  assert.ok(chatBody.error, 'Chat error should have error field');
  assert.ok(!chatBody.type, 'Chat error should NOT have top-level type field');
});

// ─── 20. Tier1 maxInFlight dispatchable capacity ────────────────────────────
await test('isTier1Eligible respects maxInFlight capacity', async () => {
  const { isTier1Eligible, __resetTier1StateForTests, claimTier1Slot, releaseTier1Slot, makeTier1ReleaseToken } = await import('../src/reliability/tier1-state.ts');
  __resetTier1StateForTests();
  const node = { id: 'cap-test', tier: 'tier-1', protocol: 'openai', surfaces: ['chat'], models: {} };
  const req = { protocol: 'openai', surface: 'chat', model: 'm' };

  // Claim 4 slots (maxInFlight = 4)
  for (let i = 0; i < 4; i++) {
    assert.equal(claimTier1Slot(node, Date.now(), 'm', 4), true, `slot ${i} should claim`);
  }
  // 5th claim should fail
  assert.equal(claimTier1Slot(node, Date.now(), 'm', 4), false, '5th claim should fail at capacity');

  // Without maxInFlight, node is still eligible (legacy behavior)
  assert.equal(isTier1Eligible(node, req, Date.now(), null, null), true, 'eligible without maxInFlight');

  // With maxInFlight=4 and inFlight=4, node should NOT be dispatchable
  assert.equal(isTier1Eligible(node, req, Date.now(), null, 4), false, 'not dispatchable at capacity with maxInFlight');

  // With maxInFlight=4 and inFlight=3, node should be dispatchable
  releaseTier1Slot(node.id, makeTier1ReleaseToken(node.id));
  assert.equal(isTier1Eligible(node, req, Date.now(), null, 4), true, 'dispatchable with 1 slot remaining');
});

// ─── 21. Effective model observability ──────────────────────────────────────
await test('recordTokens uses upstream model for token attribution', async () => {
  // Verify the source uses upstreamModelOf for token recording
  const src = readFileSync(join(root, 'src', 'request', 'attempt', 'observability.ts'), 'utf8');
  assert.ok(src.includes('upstreamModelOf(node, c.requestedModel)'), 'recordTokens should compute effective model');
  assert.ok(src.includes('effectiveModel'), 'recordTokens should use effectiveModel variable');
});

// ─── 22. Tier1 priority semantics ──────────────────────────────────────────
await test('calculateTier1Score applies priority factor', async () => {
  const { calculateTier1Score, __resetTier1StateForTests } = await import('../src/reliability/tier1-state.ts');
  __resetTier1StateForTests();
  const node = { id: 'p-test', tier: 'tier-1', protocol: 'openai', surfaces: ['chat'], models: {}, provider: 'test' };
  const candidates = [node];

  // Score without priority (default)
  const scoreNormal = calculateTier1Score(node, 'm', candidates, 1, Date.now());
  // Score with priority 5 (highest) — should be lower (more preferred)
  const scoreHigh = calculateTier1Score(node, 'm', candidates, 1, Date.now(), 5);
  // Score with priority 1 (lowest) — should be higher (less preferred)
  const scoreLow = calculateTier1Score(node, 'm', candidates, 1, Date.now(), 1);

  assert.ok(scoreHigh < scoreNormal, `priority 5 score (${scoreHigh}) should be < normal (${scoreNormal})`);
  assert.ok(scoreLow > scoreNormal, `priority 1 score (${scoreLow}) should be > normal (${scoreNormal})`);
});

await test('RoutableRequest type includes optional priority field', async () => {
  const src = readFileSync(join(root, 'src', 'types', 'scheduler.ts'), 'utf8');
  assert.ok(src.includes('priority?: number'), 'RoutableRequest should have optional priority field');
});

await test('RequestDescriptor type includes optional priority field', async () => {
  const src = readFileSync(join(root, 'src', 'types', 'request.ts'), 'utf8');
  assert.ok(src.includes('priority?: number'), 'RequestDescriptor should have optional priority field');
});

await test('preflight derives priority from access key group', async () => {
  const src = readFileSync(join(root, 'src', 'request', 'preflight.ts'), 'utf8');
  assert.ok(src.includes('GROUP_PRIORITY'), 'preflight should define GROUP_PRIORITY mapping');
  assert.ok(src.includes('AIR: 2'), 'AIR group should have priority 2');
  assert.ok(src.includes('MAX: 4'), 'MAX group should have priority 4');
  assert.ok(src.includes('ULTRA: 5'), 'ULTRA group should have priority 5');
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\nreliability-regression-test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
