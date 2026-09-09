#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Regression contract for the Claude Code -> Anthropic Messages -> OpenAI Chat
// fallback. The representative envelope covers the request-control and history
// shapes currently emitted by Claude Code that can be safely degraded onto a
// generic Chat-only upstream.

import assert from 'node:assert/strict';
import {
  convertAnthropicToOpenAIRequest,
  ConversionError,
} from '../src/conversion/anthropic-to-openai.ts';

const converted = convertAnthropicToOpenAIRequest({
  model: 'Code-Max',
  max_tokens: 4096,
  stream: true,
  system: [{ type: 'text', text: 'Initial instructions.', cache_control: { type: 'ephemeral' } }],
  thinking: { type: 'enabled', budget_tokens: 2048 },
  context_management: { edits: [] },
  output_config: { effort: 'high' },
  cache_control: { type: 'ephemeral', scope: 'session' },
  tools: [
    {
      name: 'Read',
      description: 'Read a file',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      cache_control: { type: 'ephemeral' },
      allowed_callers: ['direct'],
      defer_loading: false,
      strict: true,
      input_examples: [{ path: 'README.md' }],
      eager_input_streaming: false,
    },
    {
      type: 'advisor_20260301',
      name: 'advisor',
      model: 'claude-opus-5',
      max_uses: 2,
      max_tokens: 2048,
      caching: { type: 'ephemeral', ttl: '5m' },
    },
  ],
  tool_choice: { type: 'auto', disable_parallel_tool_use: false },
  messages: [
    { role: 'user', content: 'before' },
    {
      role: 'system',
      content: [{ type: 'text', text: 'Use the updated instructions.', cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'medium' },
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private reasoning', signature: 'sig_1' },
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'advisor', input: {} },
        {
          type: 'advisor_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: { type: 'advisor_redacted_result', encrypted_content: 'ciphertext' },
        },
        { type: 'text', text: 'I will read the file. ' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Read',
          input: { path: 'README.md' },
          caller: { type: 'direct' },
          toolset_name: 'claude_code',
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: 'file contents',
          is_error: false,
        },
      ],
    },
  ],
});

assert.equal(converted.model, 'Code-Max');
assert.equal(converted.max_tokens, 4096);
assert.equal(converted.stream, true);
assert.deepEqual(converted.messages, [
  { role: 'system', content: 'Initial instructions.' },
  { role: 'user', content: 'before' },
  { role: 'user', content: 'Use the updated instructions.' },
  {
    role: 'assistant',
    content: 'I will read the file. ',
    tool_calls: [{
      id: 'toolu_1',
      type: 'function',
      function: { name: 'Read', arguments: '{"path":"README.md"}' },
    }],
  },
  { role: 'tool', tool_call_id: 'toolu_1', content: 'file contents' },
]);
assert.equal(converted.messages.slice(1).some((message) => message.role === 'system'), false,
  'generic Chat fallback must never emit a mid-conversation system role');
assert.deepEqual(converted.tools, [{
  type: 'function',
  function: {
    name: 'Read',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
}]);
assert.equal(converted.tool_choice, 'auto');
for (const key of ['thinking', 'context_management', 'output_config', 'cache_control']) {
  assert.equal(Object.hasOwn(converted, key), false, `${key} must not leak to generic OpenAI Chat`);
}
assert.equal(converted.tools.some((tool) => tool.function?.name === 'advisor'), false,
  'Anthropic server-side advisor must not be exposed as a fake client function');

assert.throws(
  () => convertAnthropicToOpenAIRequest({
    model: 'Code-Max',
    max_tokens: 1024,
    output_config: {
      format: { type: 'json_schema', schema: { type: 'object' } },
    },
    messages: [{ role: 'user', content: 'hello' }],
  }),
  (error) => error instanceof ConversionError && /output_config/.test(error.message),
  'structured output must remain non-convertible rather than being silently dropped',
);

assert.throws(
  () => convertAnthropicToOpenAIRequest({
    model: 'Code-Max',
    max_tokens: 1024,
    tools: [{ type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-5' }],
    tool_choice: { type: 'tool', name: 'advisor' },
    messages: [{ role: 'user', content: 'hello' }],
  }),
  (error) => error instanceof ConversionError && /tool_choice references Anthropic-only server tool advisor/.test(error.message),
  'forced advisor use cannot be silently degraded',
);

assert.throws(
  () => convertAnthropicToOpenAIRequest({
    model: 'Code-Max',
    max_tokens: 1024,
    messages: [{
      role: 'assistant',
      content: [{ type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: {} }],
    }],
  }),
  (error) => error instanceof ConversionError && /server_tool_use/.test(error.message),
  'unhandled Anthropic server tools must still fail closed',
);

console.log('anthropic Claude Code beta wire compatibility test passed');
