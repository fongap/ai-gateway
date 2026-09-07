// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertOpenAIChatRequestToAnthropic as chat } from '../src/conversion/openai-chat-request-to-anthropic.ts';
import { convertResponsesRequestToAnthropic as responses } from '../src/conversion/responses-request-to-anthropic.ts';
import { convertAnthropicToOpenAIRequest as anthropic } from '../src/conversion/anthropic-to-openai.ts';
import { createOpenAIChatStreamFromAnthropic as chatStream } from '../src/conversion/anthropic-stream-to-openai-chat.ts';
import { createResponsesStreamFromAnthropic as responsesStream } from '../src/conversion/anthropic-stream-to-responses.ts';
import { createAnthropicStreamFromOpenAI as anthropicStream } from '../src/conversion/stream-converter.ts';

const message = { role: 'user', content: 'hello' };
for (const [name, convert, base] of [
  ['Chat', chat, { model: 'm', messages: [message] }],
  ['Responses', responses, { model: 'm', input: 'hello' }],
  ['Messages', anthropic, { model: 'm', max_tokens: 20, messages: [message] }],
]) {
  for (const [field, value] of [['metadata', { user_id: 'x' }], ['reasoning', { effort: 'high' }], ['unknown_option', true]]) {
    test(`${name} rejects unsupported ${field} instead of dropping semantics`, () => {
      assert.throws(() => convert({ ...base, [field]: value }), /conversion_not_supported/);
    });
  }
}
test('Chat rejects non-equivalent sampling, strict tools, and invalid JSON arguments', () => {
  assert.throws(() => chat({ model: 'm', messages: [message], temperature: 1.5 }), /conversion_not_supported/);
  assert.throws(() => chat({ model: 'm', messages: [message], tools: [{ type: 'function', function: { name: 'f', strict: true } }] }), /conversion_not_supported/);
  for (const argumentsValue of ['{broken', '[]', 'null', '1']) {
    assert.throws(() => chat({ model: 'm', messages: [{ role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: argumentsValue } }] }] }), /conversion_not_supported/);
    assert.throws(() => responses({ model: 'm', input: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: argumentsValue }] }), /conversion_not_supported/);
  }
});
test('Responses preserves assistant string content and accepts omitted message type', () => {
  const out = responses({ model: 'm', input: [{ role: 'assistant', content: 'kept' }, message] });
  assert.deepEqual(out.messages[0], { role: 'assistant', content: [{ type: 'text', text: 'kept' }] });
});
test('Messages preserves text after tool_use and emits parallel tool results at top level', () => {
  const out = anthropic({ model: 'm', messages: [
    { role: 'assistant', content: [{ type: 'text', text: 'before' }, { type: 'tool_use', id: 'c', name: 'f', input: {} }, { type: 'text', text: 'after' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: 'one' }, { type: 'tool_result', tool_use_id: 'd', content: 'two' }] },
  ] });
  assert.equal(out.messages[0].content, 'beforeafter');
  assert.deepEqual(out.messages.slice(1).map(x => [x.role, x.tool_call_id, x.content]), [['tool', 'c', 'one'], ['tool', 'd', 'two']]);
});

const encode = event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`;
const source = events => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(events.map(encode).join(''))); c.close(); } });
const read = stream => new Response(stream).text();
const eventsFrom = text => text.split('\n').filter(x => x.startsWith('data: {')).map(x => JSON.parse(x.slice(6)));
const textBlock = (index, text) => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index },
];
const toolBlock = index => [
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'call', name: 'f', input: {} } },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
  { type: 'content_block_stop', index },
];
const stop = reason => [{ type: 'message_delta', delta: { stop_reason: reason }, usage: { input_tokens: 2, output_tokens: 3 } }, { type: 'message_stop' }];

test('Responses text/tool/text uses stable indices, complete output, and one terminal event', async () => {
  const events = eventsFrom(await read(responsesStream(source([...textBlock(0, 'a'), ...toolBlock(1), ...textBlock(2, 'b'), ...stop('end_turn'), ...stop('end_turn'), ...textBlock(3, 'late')]))));
  const added = events.filter(e => e.type === 'response.output_item.added');
  const done = events.filter(e => e.type === 'response.output_item.done');
  assert.deepEqual(added.map(e => e.output_index), [0, 1, 2]);
  assert.deepEqual(done.map(e => e.output_index), [0, 1, 2]);
  for (let i = 0; i < 3; i++) assert.equal(added[i].item.id, done[i].item.id);
  assert.equal(events.filter(e => e.type === 'response.completed').length, 1);
  assert.deepEqual(events.at(-1).response.output, done.map(e => e.item));
  assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
  assert.equal(events.filter(e => e.type === 'response.function_call_arguments.done').length, 1);
});
test('Responses max_tokens emits response.incomplete with a reason', async () => {
  const events = eventsFrom(await read(responsesStream(source([...textBlock(0, 'a'), ...stop('max_tokens')]))));
  assert.equal(events.at(-1).type, 'response.incomplete');
  assert.deepEqual(events.at(-1).response.incomplete_details, { reason: 'max_output_tokens' });
});
test('Chat tool index starts at zero after text and usage does not duplicate finish', async () => {
  const text = await read(chatStream(source([...textBlock(0, 'a'), ...toolBlock(1), ...stop('tool_use'), ...stop('tool_use')])));
  const events = eventsFrom(text);
  assert.deepEqual(events.flatMap(e => e.choices ?? []).flatMap(c => c.delta?.tool_calls ?? []).map(t => t.index), [0, 0]);
  assert.equal(events.filter(e => e.choices?.[0]?.finish_reason).length, 1);
  assert.deepEqual(events.find(e => e.usage).choices, []);
  assert.equal(text.match(/\[DONE\]/g).length, 1);
});

for (const [name, convert, initial, terminal] of [
  ['Chat', chatStream, textBlock(0, 'a'), { type: 'message_stop' }],
  ['Responses', responsesStream, textBlock(0, 'a'), { type: 'message_stop' }],
  ['Messages', anthropicStream, [{ choices: [{ delta: { content: 'a' } }] }], '[DONE]'],
]) {
  test(`${name} rejects truncated and malformed streams`, async () => {
    await assert.rejects(read(convert(source(initial))), /interrupted/);
    await assert.rejects(read(convert(source([...initial, 'not-json', terminal]))), /Malformed/);
  });
  test(`${name} upstream error cannot be followed by success`, async () => {
    await assert.rejects(read(convert(source([...initial, { type: 'error', error: { message: 'private upstream detail' } }, terminal]))), /Upstream stream error/);
  });
  test(`${name} client cancellation reaches a pending upstream read`, async () => {
    let cancelled = false;
    const upstream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(initial.map(encode).join(''))); }, cancel() { cancelled = true; } });
    const reader = convert(upstream).getReader();
    await reader.read();
    await reader.cancel('client cancelled');
    assert.equal(cancelled, true);
  });
}
