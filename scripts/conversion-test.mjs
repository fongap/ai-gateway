#!/usr/bin/env node
// Anthropic <-> OpenAI protocol conversion tests.
//
//   1. Direct unit tests of src/conversion/* (request/response/stream).
//   2. Direct unit tests of src/config/protocol-fallbacks (config + chain).
//   3. Black-box handler tests of cross-protocol fallback over worker.fetch
//      against a mocked global fetch upstream (Anthropic native success,
//      Anthropic exhausted -> OpenAI conversion success, native available
//      never calls OpenAI, conversion disabled, OpenAI 429/5xx rotation,
//      client abort 499, first-event timeout rotation).
//
// Uses only node:test + node:assert. Exits 0 on success, 1 on failure.
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { __resetAllStateForTests } from '../src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '../src/reliability/tier1-state.ts';
import { __resetTier1AffinityForTests } from '../src/scheduler/tier1-affinity.ts';

import {
  convertAnthropicToOpenAIRequest,
  ConversionError,
} from '../src/conversion/anthropic-to-openai.ts';
import {
  convertOpenAIToAnthropicResponse,
  convertOpenAIUsageToAnthropic,
} from '../src/conversion/openai-to-anthropic.ts';
import { createAnthropicStreamFromOpenAI } from '../src/conversion/stream-converter.ts';
import {
  convertOpenAIChatRequestToAnthropic,
  DEFAULT_MAX_TOKENS,
} from '../src/conversion/openai-chat-request-to-anthropic.ts';
import { convertAnthropicResponseToOpenAIChat } from '../src/conversion/anthropic-response-to-openai-chat.ts';
import { createOpenAIChatStreamFromAnthropic } from '../src/conversion/anthropic-stream-to-openai-chat.ts';
import {
  loadProtocolFallbacks,
  getProtocolFallbacksDiagnostics,
  getFallbackChain,
} from '../src/config/protocol-fallbacks.ts';

const ACCESS_KEY = 'test-access-key';

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    __resetAllStateForTests();
    __resetTier1StateForTests();
    __resetTier1AffinityForTests();
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

console.log('conversion-test: starting\n');

await run('conversion: text roundtrip', () => {
  const out = convertAnthropicToOpenAIRequest({
    model: 'claude-x',
    system: 'you are helpful',
    max_tokens: 100,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  });
  assert.ok(Array.isArray(out.messages));
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].role, 'system');
  assert.equal(out.messages[0].content, 'you are helpful');
  assert.equal(out.messages[1].role, 'user');
  const userContent = out.messages[1].content;
  assert.ok(Array.isArray(userContent));
  assert.equal(userContent[0].type, 'text');
  assert.equal(userContent[0].text, 'hi');
  assert.equal(out.max_tokens, 100);
  assert.equal(out.model, 'claude-x');
});

await run('conversion: tool_use roundtrip (assistant + tool_result)', () => {
  const out = convertAnthropicToOpenAIRequest({
    max_tokens: 64,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me look that up' },
          { type: 'tool_use', id: 'call_1', name: 'lookup', input: { city: 'sf' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [{ type: 'text', text: 'sunny' }],
          },
        ],
      },
    ],
  });
  const asst = out.messages[0];
  assert.equal(asst.role, 'assistant');
  assert.equal(asst.content, 'let me look that up');
  assert.ok(Array.isArray(asst.tool_calls));
  assert.equal(asst.tool_calls.length, 1);
  assert.equal(asst.tool_calls[0].id, 'call_1');
  assert.equal(asst.tool_calls[0].type, 'function');
  assert.equal(asst.tool_calls[0].function.name, 'lookup');
  assert.equal(asst.tool_calls[0].function.arguments, JSON.stringify({ city: 'sf' }));
  const toolMsg = out.messages[1];
  assert.equal(toolMsg.role, 'tool', 'single tool_result becomes a top-level tool message');
  assert.equal(toolMsg.tool_call_id, 'call_1');
  assert.equal(toolMsg.content, 'sunny');
});

await run('conversion: response conversion (text + tool_use, finish=tool_calls)', () => {
  const out = convertOpenAIToAnthropicResponse({
    id: 'chatcmpl-1',
    model: 'up-model',
    choices: [{
      message: {
        role: 'assistant',
        content: 'hi',
        tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 },
  });
  assert.equal(out.type, 'message');
  assert.equal(out.role, 'assistant');
  assert.equal(out.stop_reason, 'tool_use');
  assert.ok(Array.isArray(out.content));
  assert.equal(out.content.length, 2);
  assert.equal(out.content[0].type, 'text');
  assert.equal(out.content[0].text, 'hi');
  assert.equal(out.content[1].type, 'tool_use');
  assert.equal(out.content[1].id, 'call_1');
  assert.equal(out.content[1].name, 'lookup');
  assert.deepEqual(out.content[1].input, {});
  assert.deepEqual(out.usage, { input_tokens: 3, output_tokens: 7 });
});

await run('conversion: usage conversion', () => {
  assert.equal(convertOpenAIUsageToAnthropic(null), null);
  assert.equal(convertOpenAIUsageToAnthropic(undefined), null);
  assert.equal(convertOpenAIUsageToAnthropic({}), null);
  assert.equal(convertOpenAIUsageToAnthropic({ prompt_tokens: 0, completion_tokens: 0 }), null);
  assert.deepEqual(convertOpenAIUsageToAnthropic({ prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 }),
    { input_tokens: 5, output_tokens: 10 });
  assert.deepEqual(convertOpenAIUsageToAnthropic({ prompt_tokens: 2, completion_tokens: 3 }),
    { input_tokens: 2, output_tokens: 3 });
});

await run('conversion: unsupported image block throws ConversionError', () => {
  let caught;
  try {
    convertAnthropicToOpenAIRequest({
      max_tokens: 10,
      messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }],
    });
  } catch (e) { caught = e; }
  assert.ok(caught instanceof ConversionError, 'expected ConversionError');
  assert.ok(String(caught.code).includes('conversion_not_supported'),
    `code should include 'conversion_not_supported', got ${caught.code}`);
});

await run('conversion: unsupported tool_choice throws ConversionError', () => {
  let caught;
  try {
    convertAnthropicToOpenAIRequest({
      max_tokens: 10,
      tool_choice: { type: 'bogus' },
      messages: [{ role: 'user', content: 'hi' }],
    });
  } catch (e) { caught = e; }
  assert.ok(caught instanceof ConversionError, 'expected ConversionError');
});

await run('conversion: OpenAI Chat -> Anthropic request — text roundtrip', () => {
  const out = convertOpenAIChatRequestToAnthropic({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(out.model, 'gpt-4o');
  assert.equal(out.max_tokens, DEFAULT_MAX_TOKENS);
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].role, 'user');
  assert.equal(out.messages[0].content, 'hi');
  assert.equal(out.system, undefined);
});

await run('conversion: OpenAI Chat -> Anthropic request — system (string) + developer (string)', () => {
  const out = convertOpenAIChatRequestToAnthropic({
    model: 'gpt-4o',
    system: 'you are helpful',
    messages: [
      { role: 'developer', content: 'be concise' },
      { role: 'user', content: 'hi' },
    ],
  });
  assert.ok(Array.isArray(out.system));
  assert.equal(out.system.length, 2);
  assert.equal(out.system[0].type, 'text');
  assert.equal(out.system[0].text, 'you are helpful');
  assert.equal(out.system[1].type, 'text');
  assert.equal(out.system[1].text, 'be concise');
  assert.equal(out.messages[0].role, 'user');
  assert.equal(out.messages[0].content, 'hi');
});

await run('conversion: OpenAI Chat -> Anthropic request — temperature/top_p/stop/stream passthrough', () => {
  const out = convertOpenAIChatRequestToAnthropic({
    model: 'gpt-4o',
    temperature: 0.7,
    top_p: 0.9,
    stop: ['END', 'STOP'],
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(out.temperature, 0.7);
  assert.equal(out.top_p, 0.9);
  assert.deepEqual(out.stop_sequences, ['END', 'STOP']);
  assert.equal(out.stream, true);
});

await run('conversion: OpenAI Chat -> Anthropic request — stop string becomes single-element array', () => {
  const out = convertOpenAIChatRequestToAnthropic({
    model: 'gpt-4o',
    stop: 'END',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.deepEqual(out.stop_sequences, ['END']);
});

await run('conversion: OpenAI Chat -> Anthropic request — max_tokens explicit pass-through', () => {
  const out = convertOpenAIChatRequestToAnthropic({
    model: 'gpt-4o',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(out.max_tokens, 256);
});

await run('conversion: OpenAI Chat -> Anthropic request — assistant tool_calls -> tool_use', () => {
  const out = convertOpenAIChatRequestToAnthropic({
    model: 'gpt-4o',
    messages: [
      { role: 'user', content: 'lookup sf' },
      {
        role: 'assistant',
        content: 'on it',
        tool_calls: [
          {
            id: 'call_42',
            type: 'function',
            function: { name: 'lookup', arguments: '{"city":"sf"}' },
          },
        ],
      },
    ],
  });
  const asst = out.messages[1];
  assert.equal(asst.role, 'assistant');
  assert.ok(Array.isArray(asst.content));
  const text = asst.content.find((b) => b.type === 'text');
  const toolUse = asst.content.find((b) => b.type === 'tool_use');
  assert.ok(text, 'has text block');
  assert.equal(text.text, 'on it');
  assert.ok(toolUse, 'has tool_use block');
  assert.equal(toolUse.id, 'call_42');
  assert.equal(toolUse.name, 'lookup');
  assert.deepEqual(toolUse.input, { city: 'sf' });
});

await run('conversion: OpenAI Chat -> Anthropic request — role=tool -> tool_result', () => {
  const out = convertOpenAIChatRequestToAnthropic({
    model: 'gpt-4o',
    messages: [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
    ],
  });
  const toolMsg = out.messages[1];
  assert.equal(toolMsg.role, 'user');
  assert.ok(Array.isArray(toolMsg.content));
  assert.equal(toolMsg.content[0].type, 'tool_result');
  assert.equal(toolMsg.content[0].tool_use_id, 'call_1');
  assert.equal(toolMsg.content[0].content, 'sunny');
});

await run('conversion: OpenAI Chat -> Anthropic request — multiple consecutive tool messages merge', () => {
  const out = convertOpenAIChatRequestToAnthropic({
    model: 'gpt-4o',
    messages: [
      {
        role: 'assistant',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'tool', tool_call_id: 'c2', content: 'r2' },
    ],
  });
  const toolMsg = out.messages[1];
  assert.equal(toolMsg.role, 'user');
  assert.equal(toolMsg.content.length, 2);
  assert.deepEqual(toolMsg.content.map((b) => b.tool_use_id), ['c1', 'c2']);
});

await run('conversion: OpenAI Chat -> Anthropic request — tools[].function.parameters -> input_schema', () => {
  const out = convertOpenAIChatRequestToAnthropic({
    model: 'gpt-4o',
    tools: [
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'look up a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(out.tools.length, 1);
  assert.equal(out.tools[0].name, 'lookup');
  assert.equal(out.tools[0].description, 'look up a city');
  assert.equal(out.tools[0].input_schema.type, 'object');
  assert.ok(out.tools[0].input_schema.properties);
});

await run('conversion: OpenAI Chat -> Anthropic request — tool_choice auto/required/none/function', () => {
  const mk = (tc) => convertOpenAIChatRequestToAnthropic({
    model: 'gpt-4o', tool_choice: tc, messages: [{ role: 'user', content: 'hi' }],
  });
  assert.deepEqual(mk('auto').tool_choice, { type: 'auto' });
  assert.deepEqual(mk('required').tool_choice, { type: 'any' });
  assert.deepEqual(mk('none').tool_choice, { type: 'none' });
  assert.deepEqual(mk({ type: 'function', function: { name: 'lookup' } }).tool_choice,
    { type: 'tool', name: 'lookup' });
  assert.deepEqual(mk({ type: 'tool', name: 'lookup' }).tool_choice,
    { type: 'tool', name: 'lookup' });
});

await run('conversion: OpenAI Chat -> Anthropic request — unsupported tool_choice type rejected', () => {
  let caught;
  try {
    convertOpenAIChatRequestToAnthropic({
      model: 'gpt-4o',
      tool_choice: { type: 'weird' },
      messages: [{ role: 'user', content: 'hi' }],
    });
  } catch (e) { caught = e; }
  assert.ok(caught instanceof ConversionError, 'expected ConversionError');
  assert.ok(String(caught.code).includes('conversion_not_supported'),
    `code should include 'conversion_not_supported', got ${caught.code}`);
});

await run('conversion: OpenAI Chat -> Anthropic request — image_url is converted to image block', () => {
  const out = convertOpenAIChatRequestToAnthropic({
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
      ],
    }],
  });
  const u = out.messages[0];
  assert.ok(Array.isArray(u.content));
  assert.equal(u.content[0].type, 'text');
  assert.equal(u.content[0].text, 'what is this?');
  assert.equal(u.content[1].type, 'image');
  assert.equal(u.content[1].source.type, 'url');
  assert.equal(u.content[1].source.url, 'https://example.com/cat.png');
});

await run('conversion: OpenAI Chat -> Anthropic request — input_audio is rejected (not silently dropped)', () => {
  let caught;
  try {
    convertOpenAIChatRequestToAnthropic({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: '...' } }],
      }],
    });
  } catch (e) { caught = e; }
  assert.ok(caught instanceof ConversionError, 'expected ConversionError for input_audio');
  assert.ok(String(caught.code).includes('conversion_not_supported'));
});

await run('conversion: OpenAI Chat -> Anthropic request — unknown role is rejected', () => {
  let caught;
  try {
    convertOpenAIChatRequestToAnthropic({
      model: 'gpt-4o',
      messages: [{ role: 'function', content: 'legacy' }],
    });
  } catch (e) { caught = e; }
  assert.ok(caught instanceof ConversionError, 'expected ConversionError for unknown role');
});

await run('conversion: OpenAI Chat -> Anthropic request — DEFAULT_MAX_TOKENS is the single source of truth', () => {
  assert.equal(DEFAULT_MAX_TOKENS, 1024);
});

await run('conversion: Anthropic response -> OpenAI Chat — text only (end_turn)', () => {
  const out = convertAnthropicResponseToOpenAIChat({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-x',
    content: [{ type: 'text', text: 'hello' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 5 },
  });
  assert.equal(out.object, 'chat.completion');
  assert.equal(out.id, 'msg_1');
  assert.equal(out.model, 'claude-x');
  assert.equal(out.choices.length, 1);
  const choice = out.choices[0];
  assert.equal(choice.index, 0);
  assert.equal(choice.message.role, 'assistant');
  assert.equal(choice.message.content, 'hello');
  assert.equal(choice.finish_reason, 'stop');
  assert.deepEqual(out.usage, { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
});

await run('conversion: Anthropic response -> OpenAI Chat — tool_use (finish=tool_use)', () => {
  const out = convertAnthropicResponseToOpenAIChat({
    id: 'msg_2',
    type: 'message',
    role: 'assistant',
    model: 'claude-x',
    content: [
      { type: 'text', text: 'on it' },
      { type: 'tool_use', id: 'call_42', name: 'lookup', input: { city: 'sf' } },
    ],
    stop_reason: 'tool_use', stop_sequence: null,
    usage: { input_tokens: 4, output_tokens: 6 },
  });
  const msg = out.choices[0].message;
  assert.equal(msg.content, 'on it');
  assert.ok(Array.isArray(msg.tool_calls));
  assert.equal(msg.tool_calls.length, 1);
  assert.equal(msg.tool_calls[0].id, 'call_42');
  assert.equal(msg.tool_calls[0].type, 'function');
  assert.equal(msg.tool_calls[0].function.name, 'lookup');
  assert.equal(msg.tool_calls[0].function.arguments, JSON.stringify({ city: 'sf' }));
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(out.usage, { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 });
});

await run('conversion: Anthropic response -> OpenAI Chat — stop_reason mapping', () => {
  const mk = (sr) => convertAnthropicResponseToOpenAIChat({
    id: 'm', type: 'message', role: 'assistant', model: 'm',
    content: [{ type: 'text', text: 'x' }], stop_reason: sr, stop_sequence: null,
  }).choices[0].finish_reason;
  assert.equal(mk('end_turn'), 'stop');
  assert.equal(mk('stop_sequence'), 'stop');
  assert.equal(mk('max_tokens'), 'length');
  assert.equal(mk('tool_use'), 'tool_calls');
});

await run('conversion: Anthropic response -> OpenAI Chat — usage total_tokens computed when missing', () => {
  const out = convertAnthropicResponseToOpenAIChat({
    id: 'm', type: 'message', role: 'assistant', model: 'm',
    content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 7, output_tokens: 11 },
  });
  assert.deepEqual(out.usage, { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 });
});

await run('conversion: Anthropic response -> OpenAI Chat — missing usage defaults to 0', () => {
  const out = convertAnthropicResponseToOpenAIChat({
    id: 'm', type: 'message', role: 'assistant', model: 'm',
    content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', stop_sequence: null,
  });
  assert.deepEqual(out.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

await run('conversion: Anthropic response -> OpenAI Chat — unsupported content type is rejected', () => {
  let caught;
  try {
    convertAnthropicResponseToOpenAIChat({
      id: 'm', type: 'message', role: 'assistant', model: 'm',
      content: [{ type: 'image', source: {} }], stop_reason: 'end_turn', stop_sequence: null,
    });
  } catch (e) { caught = e; }
  assert.ok(caught && caught.code && caught.code.includes('conversion_not_supported'),
    'expected conversion_not_supported');
});

await run('conversion: Anthropic response -> OpenAI Chat — thinking-only response is rejected (no silent loss)', () => {
  let caught;
  try {
    convertAnthropicResponseToOpenAIChat({
      id: 'm', type: 'message', role: 'assistant', model: 'm',
      content: [{ type: 'thinking', thinking: 'let me reason' }], stop_reason: 'end_turn', stop_sequence: null,
    });
  } catch (e) { caught = e; }
  assert.ok(caught && caught.code && caught.code.includes('conversion_not_supported'),
    'expected conversion_not_supported for thinking block');
});

function sseAnthropicEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function readOpenAIChatChunks(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const out = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = block.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') { out.push({ done: true }); continue; }
        try { out.push({ chunk: JSON.parse(payload) }); } catch { }
      }
    }
  }
  return out;
}

async function readSseStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

await run('conversion: stream Anthropic -> OpenAI Chat — text + end_turn, real-time', async () => {
  const anthropicChunks = [
    sseAnthropicEvent('message_start', {
      type: 'message_start',
      message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } },
    }),
    sseAnthropicEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sseAnthropicEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
    sseAnthropicEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseAnthropicEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 4, output_tokens: 1 } }),
    sseAnthropicEvent('message_stop', { type: 'message_stop' }),
  ];
  const stream = createOpenAIChatStreamFromAnthropic(makeSseResponse(anthropicChunks), {
    messageId: 'chatcmpl-test-1', model: 'claude-x',
  });
  const out = await readOpenAIChatChunks(stream);
  const chunks = out.filter((x) => x.chunk).map((x) => x.chunk);
  const dones = out.filter((x) => x.done);
  const firstDelta = chunks[0]?.choices?.[0]?.delta;
  assert.ok(firstDelta && firstDelta.role === 'assistant',
    'first chunk must carry delta.role=assistant');
  assert.equal(firstDelta.content, undefined);
  const textChunk = chunks.find((c) => c.choices?.[0]?.delta?.content === 'hi');
  assert.ok(textChunk, 'text delta emitted');
  const last = chunks.findLast((c) => c.choices?.[0]?.finish_reason);
  assert.equal(last.choices[0].finish_reason, 'stop');
  assert.equal(dones.length, 1, 'exactly one [DONE] sentinel');
});

await run('conversion: stream Anthropic -> OpenAI Chat — tool_use + tool_calls finish', async () => {
  const anthropicChunks = [
    sseAnthropicEvent('message_start', {
      type: 'message_start',
      message: { id: 'm2', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
    }),
    sseAnthropicEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_99', name: 'lookup' } }),
    sseAnthropicEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"ci' } }),
    sseAnthropicEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'ty":"sf"}' } }),
    sseAnthropicEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseAnthropicEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 1 } }),
    sseAnthropicEvent('message_stop', { type: 'message_stop' }),
  ];
  const stream = createOpenAIChatStreamFromAnthropic(makeSseResponse(anthropicChunks), {
    messageId: 'chatcmpl-test-2', model: 'claude-x',
  });
  const out = await readOpenAIChatChunks(stream);
  const chunks = out.filter((x) => x.chunk).map((x) => x.chunk);
  const startChunk = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls?.[0]?.id === 'call_99');
  assert.ok(startChunk, 'tool_call start chunk with id=call_99');
  assert.equal(startChunk.choices[0].delta.tool_calls[0].function.name, 'lookup');
  assert.equal(startChunk.choices[0].delta.tool_calls[0].function.arguments, '');
  const argChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments);
  assert.ok(argChunks.length >= 2, 'multiple argument deltas');
  const last = chunks.findLast((c) => c.choices?.[0]?.finish_reason);
  assert.equal(last.choices[0].finish_reason, 'tool_calls');
});

await run('conversion: stream Anthropic -> OpenAI Chat — message_start only is NOT a commit', async () => {
  const anthropicChunks = [
    sseAnthropicEvent('message_start', {
      type: 'message_start',
      message: { id: 'm3', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
    }),
    sseAnthropicEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ];
  const stream = createOpenAIChatStreamFromAnthropic(makeSseResponse(anthropicChunks), {
    messageId: 'chatcmpl-test-3', model: 'claude-x',
  });
  await assert.rejects(readOpenAIChatChunks(stream), /interrupted/);
});

await run('conversion: stream Anthropic -> OpenAI Chat — max_tokens maps to length', async () => {
  const anthropicChunks = [
    sseAnthropicEvent('message_start', {
      type: 'message_start',
      message: { id: 'm4', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
    }),
    sseAnthropicEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sseAnthropicEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }),
    sseAnthropicEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseAnthropicEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null } }),
    sseAnthropicEvent('message_stop', { type: 'message_stop' }),
  ];
  const stream = createOpenAIChatStreamFromAnthropic(makeSseResponse(anthropicChunks), {
    messageId: 'chatcmpl-test-4', model: 'claude-x',
  });
  const out = await readOpenAIChatChunks(stream);
  const chunks = out.filter((x) => x.chunk).map((x) => x.chunk);
  const last = chunks.findLast((c) => c.choices?.[0]?.finish_reason);
  assert.equal(last.choices[0].finish_reason, 'length');
});

await run('conversion: stream Anthropic -> OpenAI Chat — usage chunk emitted at end when tokens known', async () => {
  const anthropicChunks = [
    sseAnthropicEvent('message_start', {
      type: 'message_start',
      message: { id: 'm5', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } },
    }),
    sseAnthropicEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sseAnthropicEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
    sseAnthropicEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseAnthropicEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 7, output_tokens: 5 } }),
    sseAnthropicEvent('message_stop', { type: 'message_stop' }),
  ];
  const stream = createOpenAIChatStreamFromAnthropic(makeSseResponse(anthropicChunks), {
    messageId: 'chatcmpl-test-5', model: 'claude-x',
  });
  const out = await readOpenAIChatChunks(stream);
  const chunks = out.filter((x) => x.chunk).map((x) => x.chunk);
  const usageChunks = chunks.filter((c) => c.usage);
  assert.ok(usageChunks.length >= 1, 'at least one chunk carries usage');
  const usage = usageChunks[usageChunks.length - 1].usage;
  assert.equal(usage.prompt_tokens, 7);
  assert.equal(usage.completion_tokens, 5);
  assert.equal(usage.total_tokens, 12);
});

function makeSseResponse(events) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= events.length) { controller.close(); return; }
      controller.enqueue(encoder.encode(events[i++]));
    },
  });
}

function sseEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function readAnthropicEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const out = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = block.split('\n');
      let evName = null;
      let evData = null;
      for (const line of lines) {
        if (line.startsWith('event: ')) evName = line.slice(7).trim();
        else if (line.startsWith('data: ')) evData = line.slice(6);
      }
      if (evName) {
        let parsed = evData;
        if (evData) { try { parsed = JSON.parse(evData); } catch { } }
        out.push({ event: evName, data: parsed });
      }
    }
  }
  return out;
}

await run('conversion: stream text roundtrip', async () => {
  const openAiChunks = [
    sseEvent('', { choices: [{ delta: { role: 'assistant' } }] }),
    sseEvent('', { choices: [{ delta: { content: 'hi' } }] }),
    sseEvent('', { choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ];
  const stream = createAnthropicStreamFromOpenAI(makeSseResponse(openAiChunks), {
    messageId: 'msg_test1',
    model: 'claude-x',
    inputTokens: 4,
  });
  const events = await readAnthropicEvents(stream);
  const names = events.map((e) => e.event);
  const idx = (n) => names.indexOf(n);
  assert.ok(idx('message_start') !== -1, 'message_start emitted');
  assert.ok(idx('content_block_start') !== -1, 'content_block_start emitted');
  assert.ok(idx('content_block_delta') !== -1, 'content_block_delta emitted');
  assert.ok(idx('content_block_stop') !== -1, 'content_block_stop emitted');
  assert.ok(idx('message_delta') !== -1, 'message_delta emitted');
  assert.ok(idx('message_stop') !== -1, 'message_stop emitted');
  assert.ok(idx('message_start') < idx('content_block_start'));
  assert.ok(idx('content_block_start') < idx('content_block_delta'));
  assert.ok(idx('content_block_delta') < idx('content_block_stop'));
  assert.ok(idx('content_block_stop') < idx('message_delta'));
  assert.ok(idx('message_delta') < idx('message_stop'));
  const ms = events.find((e) => e.event === 'message_start');
  assert.equal(ms.data.message.usage.input_tokens, 4);
  const td = events.find((e) => e.event === 'content_block_delta');
  assert.equal(td.data.delta.type, 'text_delta');
  assert.equal(td.data.delta.text, 'hi');
});

await run('conversion: stream tool_calls roundtrip (split across chunks)', async () => {
  const openAiChunks = [
    sseEvent('', { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_99', function: { name: 'lookup', arguments: '' } }] } }] }),
    sseEvent('', { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } }] }),
    sseEvent('', { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"sf"}' } }] } }] }),
    sseEvent('', { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ];
  const stream = createAnthropicStreamFromOpenAI(makeSseResponse(openAiChunks), {
    messageId: 'msg_test2',
    model: 'claude-x',
  });
  const events = await readAnthropicEvents(stream);
  const cbs = events.find((e) => e.event === 'content_block_start');
  assert.ok(cbs, 'content_block_start emitted');
  assert.equal(cbs.data.content_block.type, 'tool_use');
  assert.equal(cbs.data.content_block.id, 'call_99');
  assert.equal(cbs.data.content_block.name, 'lookup');
  const deltas = events.filter((e) => e.event === 'content_block_delta');
  assert.ok(deltas.length >= 1, 'at least one content_block_delta');
  const firstDelta = deltas[0];
  assert.equal(firstDelta.data.delta.type, 'input_json_delta');
  assert.ok(typeof firstDelta.data.delta.partial_json === 'string',
    'partial_json is a string');
  assert.match(firstDelta.data.delta.partial_json, /^\{?"?ci/);
  const stop = events.find((e) => e.event === 'content_block_stop');
  assert.ok(stop, 'content_block_stop emitted');
  const md = events.find((e) => e.event === 'message_delta');
  assert.ok(md, 'message_delta emitted');
  assert.equal(md.data.delta.stop_reason, 'tool_use');
  const stopFinal = events.find((e) => e.event === 'message_stop');
  assert.ok(stopFinal, 'message_stop emitted');
  const i = (n) => events.findIndex((e) => e.event === n);
  assert.ok(i('content_block_start') < i('content_block_delta'));
  assert.ok(i('content_block_delta') < i('content_block_stop'));
  assert.ok(i('content_block_stop') < i('message_delta'));
  assert.ok(i('message_delta') < i('message_stop'));
});

await run('config: loadProtocolFallbacks returns the parsed object', () => {
  const env = { PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }) };
  const cfg = loadProtocolFallbacks(env);
  assert.deepEqual(cfg, { 'anthropic:messages': ['openai:chat_completions'] });
  assert.deepEqual(getProtocolFallbacksDiagnostics(env), []);
});

await run('config: getFallbackChain returns parsed surface objects', () => {
  const env = { PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }) };
  const chain = getFallbackChain('anthropic_messages', env);
  assert.deepEqual(chain, [{ protocol: 'openai', surface: 'chat_completions' }]);
});

await run('config: invalid JSON returns {} with diagnostic', () => {
  const env = { PROTOCOL_FALLBACKS: 'not json' };
  const cfg = loadProtocolFallbacks(env);
  assert.deepEqual(cfg, {});
  const diag = getProtocolFallbacksDiagnostics(env);
  assert.ok(diag.length > 0, 'diagnostics has at least one entry');
  assert.ok(diag.some((d) => /invalid JSON/i.test(d)), 'diagnostic mentions invalid JSON');
});

await run('config: default ON — unset env applies built-in default chain', () => {
  const cfg = loadProtocolFallbacks({});
  assert.deepEqual(cfg, {
    'anthropic:messages': ['openai:chat_completions'],
    'openai:chat_completions': ['anthropic:messages'],
  });
  assert.deepEqual(getProtocolFallbacksDiagnostics({}), [], 'default chain has no diagnostics');
});

await run('config: default ON — empty string is treated as unset', () => {
  const cfg = loadProtocolFallbacks({ PROTOCOL_FALLBACKS: '' });
  assert.deepEqual(cfg, {
    'anthropic:messages': ['openai:chat_completions'],
    'openai:chat_completions': ['anthropic:messages'],
  });
});

await run('config: "disable" literal turns the default off', () => {
  const cfg = loadProtocolFallbacks({ PROTOCOL_FALLBACKS: 'disable' });
  assert.deepEqual(cfg, {}, 'disable literal produces empty config');
  assert.deepEqual(getFallbackChain('anthropic_messages', { PROTOCOL_FALLBACKS: 'disable' }), []);
});

await run('config: explicit empty JSON overrides default (intentional turn-off)', () => {
  const cfg = loadProtocolFallbacks({ PROTOCOL_FALLBACKS: '{"anthropic:messages":[]}' });
  assert.deepEqual(cfg, { 'anthropic:messages': [] });
  assert.deepEqual(getFallbackChain('anthropic_messages', { PROTOCOL_FALLBACKS: '{"anthropic:messages":[]}' }), []);
});

await run('config: "disable" + explicit JSON both yield the same opt-out (sanity)', () => {
  const disable = loadProtocolFallbacks({ PROTOCOL_FALLBACKS: 'disable' });
  const explicit = loadProtocolFallbacks({ PROTOCOL_FALLBACKS: '{"anthropic:messages":[]}' });
  assert.equal(Object.keys(disable).length, 0, 'disable drops the key entirely');
  assert.equal(Object.keys(explicit).length, 1, 'explicit empty keeps the key');
});

await run('config: bad key format -> diagnostic, key rejected', () => {
  const env = { PROTOCOL_FALLBACKS: '{"foo": ["bar"]}' };
  const cfg = loadProtocolFallbacks(env);
  assert.deepEqual(cfg, {}, 'bad key is not accepted');
  const diag = getProtocolFallbacksDiagnostics(env);
  assert.ok(diag.length > 0, 'diagnostics produced');
  assert.ok(diag.some((d) => /protocol:surface/i.test(d) || /unknown protocol/i.test(d) || /must be in the form/i.test(d)),
    'diagnostic mentions protocol:surface shape');
});

await run('config: bad value -> diagnostic, value not accepted', () => {
  const env = { PROTOCOL_FALLBACKS: '{"anthropic:messages": ["foo"]}' };
  const cfg = loadProtocolFallbacks(env);
  assert.deepEqual(cfg['anthropic:messages'] ?? null, null,
    'bad value is rejected and the chain is empty');
  const diag = getProtocolFallbacksDiagnostics(env);
  assert.ok(diag.length > 0, 'diagnostics produced');
});

await run('config: unsupported conversion source -> blocking error', () => {
  const env = { PROTOCOL_FALLBACKS: '{"fongap:studio": ["openai:chat_completions"]}' };
  const cfg = loadProtocolFallbacks(env);
  assert.deepEqual(cfg, {}, 'unsupported source produces empty config');
  const diag = getProtocolFallbacksDiagnostics(env);
  assert.ok(diag.length > 0, 'diagnostics produced');
  assert.ok(diag.some((d) => /not a supported conversion|unknown protocol/i.test(d)), 'diagnostic mentions unsupported conversion');
});

await run('config: unsupported conversion target -> blocking error', () => {
  const env = { PROTOCOL_FALLBACKS: '{"anthropic:messages": ["openai:responses"]}' };
  const cfg = loadProtocolFallbacks(env);
  assert.deepEqual(cfg, {}, 'unsupported target produces empty config');
  const diag = getProtocolFallbacksDiagnostics(env);
  assert.ok(diag.length > 0, 'diagnostics produced');
  assert.ok(diag.some((d) => /not a supported conversion/i.test(d)), 'diagnostic mentions unsupported conversion');
});

const upstreamCalls = [];
let routeHandlers = {};

function installMockFetch() {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const handler = routeHandlers[url.hostname];
    if (!handler) throw new Error(`no mock upstream for ${url.hostname}`);
    const req = init?.body !== undefined
      ? new Request(url, { method: 'POST', headers: init.headers, body: init.body })
      : null;
    if (req) {
      upstreamCalls.push({ host: url.hostname, url, body: JSON.parse(init.body), headers: init.headers });
    } else {
      upstreamCalls.push({ host: url.hostname, url, body: null, headers: init.headers });
    }
    return handler(req ?? {}, url, init);
  };
}

function resetMock() {
  upstreamCalls.length = 0;
  routeHandlers = {};
}

function makeEnv({ tier1, tier2, secrets, extraEnv } = {}) {
  return {
    GATEWAY_ACCESS_KEY_AIR: ACCESS_KEY,
    GATEWAY_ACCESS_MODELS_AIR: 'claude-x',
    TIER1_SCHEDULER_SEED: 'conversion-test',
    ...(tier1 ? { TIER1_NODES_CONFIG_01: JSON.stringify(tier1) } : {}),
    ...(tier2 ? { TIER2_NODES_CONFIG_01: JSON.stringify(tier2) } : {}),
    ...(secrets ? { TIER1_NODES_SECRETS_01: JSON.stringify(secrets) } : {}),
    ...extraEnv,
  };
}

const anthropicNode = (id, extra = {}) => ({
  id,
  provider: 'mock',
  protocol: 'anthropic',
  surfaces: ['messages'],
  base_url: `https://${id}.example.com`,
  models: { 'claude-x': 'up-model' },
  ...extra,
});

const openaiNode = (id, extra = {}) => ({
  id,
  provider: 'mock',
  protocol: 'openai',
  surfaces: ['chat_completions'],
  base_url: `https://${id}.example.com/v1`,
  models: { 'claude-x': 'up-model' },
  ...extra,
});

function messagesRequest(body) {
  return new Request('https://gateway.example.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ACCESS_KEY },
    body: JSON.stringify(body),
  });
}

function jsonUpstream(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const okAnthropicMessage = () => ({
  id: 'msg_native', type: 'message', role: 'assistant', model: 'up-model',
  content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

const okOpenAICompletion = () => ({
  id: 'chatcmpl-1', model: 'up-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

installMockFetch();

await run('handler: Anthropic native success returns native-format response', async () => {
  resetMock();
  routeHandlers['a1.example.com'] = () => jsonUpstream(okAnthropicMessage());
  const env = makeEnv({
    tier1: [anthropicNode('a1')],
    secrets: { a1: 'k' },
  });
  const res = await worker.fetch(messagesRequest({
    model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'message');
  assert.equal(body.content[0].type, 'text');
  assert.equal(body.content[0].text, 'hello');
  const call = upstreamCalls[0];
  assert.equal(new URL(call.url).pathname, '/v1/messages');
  assert.equal(call.body.model, 'up-model');
  assert.equal(call.headers.get('x-api-key'), 'k');
  assert.equal(call.headers.get('authorization'), null);
});

await run('handler: Anthropic exhausted -> OpenAI conversion success', async () => {
  resetMock();
  routeHandlers['a1.example.com'] = () => jsonUpstream({ error: { message: 'overloaded' } }, 529);
  routeHandlers['o1.example.com'] = () => jsonUpstream(okOpenAICompletion());
  const env = makeEnv({
    tier1: [anthropicNode('a1'), openaiNode('o1')],
    secrets: { a1: 'k', o1: 'k' },
    extraEnv: {
      PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }),
      EXPOSE_UPSTREAM_INFO: 'true',
    },
  });
  const res = await worker.fetch(messagesRequest({
    model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.ok(Array.isArray(body.content));
  assert.equal(body.content[0].type, 'text');
  assert.equal(body.content[0].text, 'hello');
  assert.equal(body.stop_reason, 'end_turn');
  const hosts = upstreamCalls.map((c) => c.host);
  assert.ok(hosts.includes('o1.example.com'), `OpenAI node was called: ${hosts.join(',')}`);
  assert.equal(res.headers.get('x-gateway-node'), 'o1');
  const openAiCall = upstreamCalls.find((c) => c.host === 'o1.example.com');
  assert.equal(openAiCall.body.model, 'up-model');
  assert.equal(openAiCall.body.max_tokens, 64);
  assert.equal(openAiCall.body.messages[0].role, 'user');
  assert.equal(openAiCall.body.messages[0].content, 'hi');
});

await run('handler: native available -> OpenAI fallback is never called', async () => {
  resetMock();
  routeHandlers['a1.example.com'] = () => jsonUpstream(okAnthropicMessage());
  let o1Calls = 0;
  routeHandlers['o1.example.com'] = () => { o1Calls++; return jsonUpstream(okOpenAICompletion()); };
  const env = makeEnv({
    tier1: [anthropicNode('a1'), openaiNode('o1')],
    secrets: { a1: 'k', o1: 'k' },
    extraEnv: {
      PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }),
      EXPOSE_UPSTREAM_INFO: 'true',
    },
  });
  const res = await worker.fetch(messagesRequest({
    model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.content[0].text, 'hello');
  assert.equal(res.headers.get('x-gateway-node'), 'a1');
  assert.equal(o1Calls, 0, 'native node answered; OpenAI fallback must not be called');
});

await run('handler: conversion disabled (no fallback) -> Anthropic exhausted is 5xx', async () => {
  resetMock();
  routeHandlers['a1.example.com'] = () => jsonUpstream({ error: { message: 'overloaded' } }, 529);
  routeHandlers['o1.example.com'] = () => jsonUpstream(okOpenAICompletion());
  const env = makeEnv({
    tier1: [anthropicNode('a1'), openaiNode('o1')],
    secrets: { a1: 'k', o1: 'k' },
    extraEnv: { PROTOCOL_FALLBACKS: 'disable' },
  });
  const res = await worker.fetch(messagesRequest({
    model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.ok(res.status >= 500 && res.status < 600, `expected 5xx, got ${res.status}`);
  const openAiHosts = upstreamCalls.filter((c) => c.host === 'o1.example.com');
  assert.equal(openAiHosts.length, 0, 'no OpenAI calls when fallback is disabled');
});

await run('handler: OpenAI 429 then 200 -> fallback retries and succeeds', async () => {
  resetMock();
  routeHandlers['a1.example.com'] = () => jsonUpstream({ error: { message: 'overloaded' } }, 529);
  routeHandlers['o1.example.com'] = () => jsonUpstream({ error: { message: 'rate limit' } }, 429, { 'retry-after': '0' });
  routeHandlers['o2.example.com'] = () => jsonUpstream(okOpenAICompletion());
  const env = makeEnv({
    tier1: [anthropicNode('a1'), openaiNode('o1'), openaiNode('o2')],
    secrets: { a1: 'k', o1: 'k', o2: 'k' },
    extraEnv: {
      PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }),
      EXPOSE_UPSTREAM_INFO: 'true',
      MODELS_CONFIG: JSON.stringify({ 'claude-x': { policy: 'fast' } }),
      POLICIES_CONFIG: JSON.stringify({ fast: { max_attempts: 3 } }),
    },
  });
  const res = await worker.fetch(messagesRequest({
    model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.equal(res.status, 200, 'final response must be 200 after retry');
  const body = await res.json();
  assert.equal(body.type, 'message');
  assert.equal(body.content[0].text, 'hello');
  const hosts = upstreamCalls.map((c) => c.host);
  assert.ok(hosts.includes('o1.example.com'), 'o1 was attempted (429)');
  assert.ok(hosts.includes('o2.example.com'), 'o2 was attempted (200)');
  assert.equal(res.headers.get('x-gateway-node'), 'o2');
});

await run('handler: client abort -> 499', async () => {
  resetMock();
  const hang = () => async (req, url, init) => new Promise((_, reject) => {
    if (init?.signal?.aborted) { reject(new Error('aborted')); return; }
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  routeHandlers['a1.example.com'] = hang();
  const env = makeEnv({
    tier1: [anthropicNode('a1')],
    secrets: { a1: 'k' },
    extraEnv: { FAILOVER_BUDGET_MS: '30000' },
  });
  const controller = new AbortController();
  const req = new Request('https://gateway.example.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ACCESS_KEY },
    body: JSON.stringify({
      model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
    }),
    signal: controller.signal,
  });
  const pending = worker.fetch(req, env, {});
  await new Promise((r) => setTimeout(r, 50));
  controller.abort();
  const res = await pending;
  assert.equal(res.status, 499, 'client abort must return 499');
});

await run('handler: first-event timeout -> rotates to next node', async () => {
  resetMock();
  const stalledStream = () => {
    const encoder = new TextEncoder();
    let i = 0;
    const lines = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"up-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    ];
    return new ReadableStream({
      pull(controller) {
        if (i >= lines.length) return;
        controller.enqueue(encoder.encode(lines[i++]));
      },
    });
  };
  const goodStream = () => {
    const encoder = new TextEncoder();
    let i = 0;
    const lines = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m2","type":"message","role":"assistant","model":"up-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":1,"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    return new ReadableStream({
      pull(controller) {
        if (i >= lines.length) { controller.close(); return; }
        controller.enqueue(encoder.encode(lines[i++]));
      },
    });
  };
  const stalledResponse = () => new Response(
    stalledStream(),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const goodResponse = () => new Response(
    goodStream(),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  routeHandlers['a1.example.com'] = () => stalledResponse();
  routeHandlers['a2.example.com'] = () => goodResponse();
  const env = makeEnv({
    tier1: [anthropicNode('a1'), anthropicNode('a2')],
    secrets: { a1: 'k', a2: 'k' },
    extraEnv: {
      FAILOVER_BUDGET_MS: '6000',
      EXPOSE_UPSTREAM_INFO: 'true',
    },
  });
  const res = await worker.fetch(messagesRequest({
    model: 'claude-x', max_tokens: 64, stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.equal(res.status, 200, 'rotation after first-event timeout must succeed');
  const text = await res.text();
  assert.match(text, /"text_delta","text":"hi"/, 'response contains real text from a2');
  const hosts = upstreamCalls.map((c) => c.host);
  assert.ok(hosts.includes('a1.example.com'), 'a1 was attempted');
  assert.ok(hosts.includes('a2.example.com'), 'a2 was attempted after a1 stalled');
});

await run('handler: conversion shares max_attempts budget with native', async () => {
  resetMock();
  let a1Calls = 0, a2Calls = 0;
  routeHandlers['a1.example.com'] = () => { a1Calls++; return jsonUpstream({ error: { message: 'overloaded' } }, 529); };
  routeHandlers['a2.example.com'] = () => { a2Calls++; return jsonUpstream({ error: { message: 'overloaded' } }, 529); };
  routeHandlers['o1.example.com'] = () => jsonUpstream(okOpenAICompletion());
  const env = makeEnv({
    tier1: [anthropicNode('a1'), anthropicNode('a2'), openaiNode('o1')],
    secrets: { a1: 'k', a2: 'k', o1: 'k' },
    extraEnv: {
      PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }),
      EXPOSE_UPSTREAM_INFO: 'true',
      MODELS_CONFIG: JSON.stringify({ 'claude-x': { policy: 'default' } }),
      POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 3 } }),
    },
  });
  const res = await worker.fetch(messagesRequest({
    model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.equal(res.status, 200, 'should succeed on 3rd attempt (fallback)');
  const body = await res.json();
  assert.equal(body.content[0].text, 'hello');
  assert.equal(res.headers.get('x-gateway-node'), 'o1');
  assert.equal(a1Calls + a2Calls, 2, 'two native attempts before fallback');
});

await run('handler: conversion shares failover_budget_ms', async () => {
  resetMock();
  routeHandlers['a1.example.com'] = () => jsonUpstream({ error: { message: 'overloaded' } }, 529);
  routeHandlers['o1.example.com'] = () => jsonUpstream(okOpenAICompletion());
  const env = makeEnv({
    tier1: [anthropicNode('a1'), openaiNode('o1')],
    secrets: { a1: 'k', o1: 'k' },
    extraEnv: {
      PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }),
      EXPOSE_UPSTREAM_INFO: 'true',
      FAILOVER_BUDGET_MS: '30000',
    },
  });
  const res = await worker.fetch(messagesRequest({
    model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.equal(res.status, 200, 'conversion should succeed within failover budget');
  const body = await res.json();
  assert.equal(body.content[0].text, 'hello');
  assert.equal(res.headers.get('x-gateway-node'), 'o1');
});

await run('handler: hedge never crosses protocol', async () => {
  resetMock();
  let o1Calls = 0;
  const slowStream = () => {
    const encoder = new TextEncoder();
    let i = 0;
    const lines = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"up-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    ];
    return new ReadableStream({
      async pull(controller) {
        if (i >= lines.length) return;
        await new Promise(r => setTimeout(r, 200));
        controller.enqueue(encoder.encode(lines[i++]));
      },
    });
  };
  routeHandlers['a1.example.com'] = () => new Response(slowStream(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  routeHandlers['a2.example.com'] = () => jsonUpstream(okAnthropicMessage());
  routeHandlers['o1.example.com'] = () => { o1Calls++; return jsonUpstream(okOpenAICompletion()); };
  const env = makeEnv({
    tier1: [anthropicNode('a1'), anthropicNode('a2'), openaiNode('o1')],
    secrets: { a1: 'k', a2: 'k', o1: 'k' },
    extraEnv: {
      PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }),
      EXPOSE_UPSTREAM_INFO: 'true',
      HEDGE_DELAY_MS: '50',
      MODELS_CONFIG: JSON.stringify({ 'claude-x': { policy: 'default' } }),
      POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 2, hedge: { enabled: true, tiers: ['tier1'] } } }),
    },
  });
  const res = await worker.fetch(messagesRequest({
    model: 'claude-x', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.equal(res.status, 200);
  const a2Hosts = upstreamCalls.filter(c => c.host === 'a2.example.com');
  assert.ok(a2Hosts.length > 0, 'hedge should use same-protocol node (a2)');
  assert.equal(o1Calls, 0, 'OpenAI fallback must not be used as hedge twin');
});

await run('handler: conversion error does not pollute node health', async () => {
  resetMock();
  routeHandlers['a1.example.com'] = () => jsonUpstream({ error: { message: 'overloaded' } }, 529);
  routeHandlers['o1.example.com'] = () => {
    return new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  const env = makeEnv({
    tier1: [anthropicNode('a1'), openaiNode('o1')],
    secrets: { a1: 'k', o1: 'k' },
    extraEnv: {
      PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }),
      EXPOSE_UPSTREAM_INFO: 'true',
    },
  });
  const res = await worker.fetch(messagesRequest({
    model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.ok(res.status >= 500, 'should fail');
  const openAiCall = upstreamCalls.find(c => c.host === 'o1.example.com');
  assert.ok(openAiCall, 'OpenAI fallback was attempted');
});

await run('regression: no native candidate + configured fallback -> 200 via OpenAI', async () => {
  resetMock();
  routeHandlers['o1.example.com'] = () => jsonUpstream(okOpenAICompletion());
  const env = makeEnv({
    tier1: [openaiNode('o1')],
    secrets: { o1: 'k' },
    extraEnv: {
      PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }),
      EXPOSE_UPSTREAM_INFO: 'true',
    },
  });
  const res = await worker.fetch(messagesRequest({
    model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.equal(res.status, 200, 'no native candidate + configured fallback must not 404');
  const body = await res.json();
  assert.equal(body.type, 'message', 'client still sees Anthropic-format');
  assert.equal(body.content[0].text, 'hello');
  const hosts = upstreamCalls.map((c) => c.host);
  assert.deepEqual(hosts, ['o1.example.com'], 'the OpenAI fallback node served the request');
  assert.equal(res.headers.get('x-gateway-node'), 'o1');
  const openAiCall = upstreamCalls.find((c) => c.host === 'o1.example.com');
  assert.equal(openAiCall.body.model, 'up-model');
  assert.equal(openAiCall.body.max_tokens, 64);
  assert.equal(openAiCall.body.messages[0].content, 'hi', 'the Anthropic body was converted to OpenAI chat');
});

await run('regression: no native candidate + no fallback configured -> 404', async () => {
  resetMock();
  routeHandlers['o1.example.com'] = () => jsonUpstream(okOpenAICompletion());
  const env = makeEnv({
    tier1: [openaiNode('o1')],
    secrets: { o1: 'k' },
    extraEnv: { PROTOCOL_FALLBACKS: 'disable' },
  });
  const res = await worker.fetch(messagesRequest({
    model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.equal(res.status, 404, 'no fallback configured -> fail closed with 404');
  assert.equal(upstreamCalls.length, 0, 'no upstream is contacted');
  const body = await res.json();
  assert.match(body.error.message, /No configured route can serve model/);
});

await run('regression: fallback configured but target node lacks the model -> 404', async () => {
  resetMock();
  routeHandlers['o1.example.com'] = () => jsonUpstream(okOpenAICompletion());
  const env = makeEnv({
    tier1: [openaiNode('o1', { models: { 'other-model': 'up' } })],
    secrets: { o1: 'k' },
    extraEnv: {
      PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }),
      EXPOSE_UPSTREAM_INFO: 'true',
    },
  });
  const res = await worker.fetch(messagesRequest({
    model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.equal(res.status, 404, 'a configured fallback with no candidate must still 404');
  assert.equal(upstreamCalls.length, 0, 'no upstream is contacted');
});

await run('regression: fallback target surface unsupported (responses-only) -> 404', async () => {
  resetMock();
  const openaiResponsesNode = (id, extra = {}) => ({
    id, provider: 'mock', protocol: 'openai', surfaces: ['responses'],
    base_url: `https://${id}.example.com/v1`, models: { 'claude-x': 'up-model' }, ...extra,
  });
  routeHandlers['o-resp.example.com'] = () => jsonUpstream({ object: 'response' });
  const env = makeEnv({
    tier1: [openaiResponsesNode('o-resp')],
    secrets: { 'o-resp': 'k' },
    extraEnv: {
      PROTOCOL_FALLBACKS: JSON.stringify({ 'anthropic:messages': ['openai:chat_completions'] }),
      EXPOSE_UPSTREAM_INFO: 'true',
    },
  });
  const res = await worker.fetch(messagesRequest({
    model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.equal(res.status, 404, 'a responses-only node must not count as a chat_completions fallback');
  assert.equal(upstreamCalls.length, 0, 'no upstream is contacted');
});

function chatCompletionsRequest(body) {
  return new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify(body),
  });
}

await run('handler: OpenAI Chat client + only Anthropic upstream -> success (non-stream)', async () => {
  resetMock();
  routeHandlers['a1.example.com'] = () => jsonUpstream(okAnthropicMessage());
  const env = makeEnv({
    tier1: [anthropicNode('a1')],
    secrets: { a1: 'k' },
    extraEnv: { EXPOSE_UPSTREAM_INFO: 'true' },
  });
  const res = await worker.fetch(chatCompletionsRequest({
    model: 'claude-x', messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.role, 'assistant');
  assert.equal(body.choices[0].message.content, 'hello');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.ok(body.usage);
  assert.equal(res.headers.get('x-gateway-node'), 'a1');
  const call = upstreamCalls[0];
  assert.equal(new URL(call.url).pathname, '/v1/messages');
  assert.equal(call.body.messages[0].role, 'user');
  assert.equal(call.body.messages[0].content, 'hi');
  assert.ok(call.body.max_tokens && call.body.max_tokens > 0,
    'converter supplied a max_tokens default');
  assert.equal(call.headers.get('x-api-key'), 'k');
  assert.equal(call.headers.get('authorization'), null);
});

await run('handler: OpenAI Chat client + only Anthropic upstream -> success (stream)', async () => {
  resetMock();
  const lines = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"up-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":1,"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const encoder = new TextEncoder();
  let i = 0;
  routeHandlers['a1.example.com'] = () => new Response(new ReadableStream({
    pull(controller) {
      if (i >= lines.length) { controller.close(); return; }
      controller.enqueue(encoder.encode(lines[i++]));
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const env = makeEnv({
    tier1: [anthropicNode('a1')],
    secrets: { a1: 'k' },
    extraEnv: { EXPOSE_UPSTREAM_INFO: 'true' },
  });
  const res = await worker.fetch(chatCompletionsRequest({
    model: 'claude-x', stream: true, messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const text = await res.text();
  assert.match(text, /"delta":\{"role":"assistant"\}/, 'role header emitted');
  assert.match(text, /"delta":\{"content":"hi"\}/, 'text content emitted');
  assert.match(text, /"finish_reason":"stop"/, 'finish_reason emitted');
  assert.match(text, /\[DONE\]/, '[DONE] sentinel emitted');
  assert.doesNotMatch(text, /event: message_start/);
  assert.doesNotMatch(text, /event: message_stop/);
  assert.doesNotMatch(text, /text_delta/);
});

await run('handler: OpenAI Chat client + Anthropic 529 -> OpenAI error envelope (cross-protocol error shape)', async () => {
  resetMock();
  routeHandlers['a1.example.com'] = () => jsonUpstream({ error: { message: 'overloaded' } }, 529);
  const env = makeEnv({
    tier1: [anthropicNode('a1')],
    secrets: { a1: 'k' },
  });
  const res = await worker.fetch(chatCompletionsRequest({
    model: 'claude-x', messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.equal(res.status, 502, 'terminal 502 from exhausted pool');
  const body = await res.json();
  assert.ok(body.error, 'OpenAI-shaped error envelope');
  assert.equal(typeof body.error.message, 'string');
  assert.equal(body.type, undefined, 'Anthropic type field is not present');
  assert.equal(body.error.type, undefined, 'no Anthropic error.type classification');
});

await run('handler: OpenAI Chat client + Anthropic 529 -> rotation 429 retry', async () => {
  resetMock();
  routeHandlers['a1.example.com'] = () => jsonUpstream({ error: { message: 'overloaded' } }, 529);
  routeHandlers['a2.example.com'] = () => jsonUpstream(okAnthropicMessage());
  const env = makeEnv({
    tier1: [anthropicNode('a1'), anthropicNode('a2')],
    secrets: { a1: 'k', a2: 'k' },
    extraEnv: {
      EXPOSE_UPSTREAM_INFO: 'true',
      MODELS_CONFIG: JSON.stringify({ 'claude-x': { policy: 'fast' } }),
      POLICIES_CONFIG: JSON.stringify({ fast: { max_attempts: 3 } }),
    },
  });
  const res = await worker.fetch(chatCompletionsRequest({
    model: 'claude-x', messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, 'hello');
  assert.equal(res.headers.get('x-gateway-node'), 'a2');
  const hosts = upstreamCalls.map((c) => c.host);
  assert.ok(hosts.includes('a1.example.com'));
  assert.ok(hosts.includes('a2.example.com'));
});

await run('handler: OpenAI Chat client + Anthropic upstream with tool_use', async () => {
  resetMock();
  const anthropicToolUse = () => ({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'up-model',
    content: [
      { type: 'text', text: 'on it' },
      { type: 'tool_use', id: 'call_42', name: 'lookup', input: { city: 'sf' } },
    ],
    stop_reason: 'tool_use', stop_sequence: null,
    usage: { input_tokens: 2, output_tokens: 3 },
  });
  routeHandlers['a1.example.com'] = () => jsonUpstream(anthropicToolUse());
  const env = makeEnv({
    tier1: [anthropicNode('a1')],
    secrets: { a1: 'k' },
  });
  const res = await worker.fetch(chatCompletionsRequest({
    model: 'claude-x',
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    messages: [{ role: 'user', content: 'lookup sf' }],
  }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  const msg = body.choices[0].message;
  assert.equal(msg.content, 'on it');
  assert.ok(Array.isArray(msg.tool_calls));
  assert.equal(msg.tool_calls[0].id, 'call_42');
  assert.equal(msg.tool_calls[0].function.name, 'lookup');
  const call = upstreamCalls[0];
  assert.equal(call.body.tools[0].name, 'lookup');
  assert.ok(call.body.tools[0].input_schema, 'input_schema present on Anthropic wire');
});

await run('handler: OpenAI Chat native success unchanged when native node available', async () => {
  resetMock();
  routeHandlers['o1.example.com'] = () => jsonUpstream(okOpenAICompletion());
  const env = makeEnv({
    tier1: [openaiNode('o1')],
    secrets: { o1: 'k' },
    extraEnv: { EXPOSE_UPSTREAM_INFO: 'true' },
  });
  const res = await worker.fetch(chatCompletionsRequest({
    model: 'claude-x', messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.role, 'assistant');
  assert.equal(body.choices[0].message.content, 'hello');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(body.type, undefined, 'no Anthropic envelope leaked through');
  assert.equal(res.headers.get('x-gateway-node'), 'o1');
  const anthropicHosts = upstreamCalls.filter((c) => c.host === 'a1.example.com');
  assert.equal(anthropicHosts.length, 0, 'native OpenAI Chat served; no Anthropic hop');
});

await run('handler: conversion error skips the fallback target -> gateway exhausted (not 400)', async () => {
  resetMock();
  routeHandlers['a1.example.com'] = () => jsonUpstream(okAnthropicMessage());
  const env = makeEnv({
    tier1: [anthropicNode('a1')],
    secrets: { a1: 'k' },
  });
  const res = await worker.fetch(chatCompletionsRequest({
    model: 'claude-x',
    tool_choice: { type: 'weird_unsupported_shape' },
    messages: [{ role: 'user', content: 'hi' }],
  }), env, {});
  assert.ok(res.status !== 400, 'a legal client request must never get a client 400 from a conversion incompatibility');
  const body = await res.json();
  assert.ok(body.error, 'OpenAI-shaped error envelope');
  assert.equal(body.type, undefined, 'no Anthropic envelope');
  assert.equal(upstreamCalls.length, 0, 'no upstream contact after conversion error');
});

const anthropicResponsesNode = (id, extra = {}) => ({
  id,
  provider: 'mock',
  protocol: 'anthropic',
  surfaces: ['messages'],
  base_url: `https://${id}.example.com`,
  models: { 'code-max': 'up-model' },
  ...extra,
});

const openaiResponsesNodeOnly = (id, extra = {}) => ({
  id,
  provider: 'mock',
  protocol: 'openai',
  surfaces: ['responses'],
  base_url: `https://${id}.example.com/v1`,
  models: { 'code-max': 'up-model' },
  ...extra,
});

function responsesApiRequest(body) {
  return new Request('https://gateway.example.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify(body),
  });
}

const okResponsesObject = () => ({
  id: 'resp_up1', object: 'response', created_at: 1, status: 'completed', model: 'up-model',
  output: [{ id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
});

await run('handler: OpenAI Responses client + only Anthropic upstream (no fallback) -> 404', async () => {
  resetMock();
  routeHandlers['a1.example.com'] = () => jsonUpstream(okAnthropicMessage());
  const env = makeEnv({
    tier1: [anthropicResponsesNode('a1')],
    secrets: { a1: 'k' },
    extraEnv: { EXPOSE_UPSTREAM_INFO: 'true' },
  });
  const res = await worker.fetch(responsesApiRequest({
    model: 'code-max', input: 'hi',
  }), env, {});
  assert.equal(res.status, 404, '404 from no compatible node');
});

await run('handler: OpenAI Responses client + only Anthropic upstream (no fallback, stream) -> 404', async () => {
  resetMock();
  routeHandlers['a1.example.com'] = () => jsonUpstream(okAnthropicMessage());
  const env = makeEnv({
    tier1: [anthropicResponsesNode('a1')],
    secrets: { a1: 'k' },
    extraEnv: { EXPOSE_UPSTREAM_INFO: 'true' },
  });
  const res = await worker.fetch(responsesApiRequest({
    model: 'code-max', input: 'hi', stream: true,
  }), env, {});
  assert.equal(res.status, 404, '404 from no compatible node');
});

await run('handler: OpenAI Responses client + Anthropic 529 (no fallback) -> 404', async () => {
  resetMock();
  routeHandlers['a1.example.com'] = () => jsonUpstream({ error: { message: 'overloaded' } }, 529);
  const env = makeEnv({
    tier1: [anthropicResponsesNode('a1')],
    secrets: { a1: 'k' },
  });
  const res = await worker.fetch(responsesApiRequest({
    model: 'code-max', input: 'hi',
  }), env, {});
  assert.equal(res.status, 404, '404 from no compatible node');
});

await run('handler: OpenAI Responses client + only OpenAI Responses upstream -> success (native path)', async () => {
  resetMock();
  routeHandlers['r1.example.com'] = () => jsonUpstream(okResponsesObject());
  const env = makeEnv({
    tier1: [openaiResponsesNodeOnly('r1')],
    secrets: { r1: 'k' },
    extraEnv: { EXPOSE_UPSTREAM_INFO: 'true' },
  });
  const res = await worker.fetch(responsesApiRequest({
    model: 'code-max', input: 'hi',
  }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, 'response');
  assert.equal(body.model, 'code-max');
  assert.equal(body.output[0].content[0].text, 'hello');
  assert.equal(res.headers.get('x-gateway-node'), 'r1');
});

await run('handler: OpenAI Responses client + Anthropic upstream with tool_use (no fallback) -> 404', async () => {
  resetMock();
  routeHandlers['a1.example.com'] = () => jsonUpstream({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'up-model',
    content: [
      { type: 'text', text: 'on it' },
      { type: 'tool_use', id: 'call_42', name: 'lookup', input: { city: 'sf' } },
    ],
    stop_reason: 'tool_use', stop_sequence: null,
    usage: { input_tokens: 2, output_tokens: 3 },
  });
  const env = makeEnv({
    tier1: [anthropicResponsesNode('a1')],
    secrets: { a1: 'k' },
  });
  const res = await worker.fetch(responsesApiRequest({
    model: 'code-max',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'lookup sf' }] },
    ],
  }), env, {});
  assert.equal(res.status, 404, '404 from no compatible node');
});

console.log(`\nconversion-test: ${passed} passed, ${failed} failed.`);
if (process.exitCode) process.exit(1);
