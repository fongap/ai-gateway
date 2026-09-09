#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Regression contract for Claude Code -> Anthropic Messages -> OpenAI Chat.
// Anthropic tool_result.is_error has no portable OpenAI Chat equivalent. The
// fallback must preserve tool_call_id + content, drop only the boolean marker,
// and must not reject the request before dispatch.

import assert from 'node:assert/strict';
import {
  convertAnthropicToOpenAIRequest,
  ConversionError,
} from '../src/conversion/anthropic-to-openai.ts';

const converted = convertAnthropicToOpenAIRequest({
  model: 'Code-Max',
  max_tokens: 512,
  messages: [
    { role: 'user', content: 'Run the test tool' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_test', name: 'get_test', input: {} }],
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_test',
        content: 'command failed',
        is_error: true,
      }],
    },
  ],
  tools: [{ name: 'get_test', description: 'Test tool', input_schema: { type: 'object', properties: {} } }],
});

assert.equal(converted.model, 'Code-Max');
assert.deepEqual(converted.messages[2], {
  role: 'tool',
  tool_call_id: 'toolu_test',
  content: 'command failed',
});
assert.equal(Object.hasOwn(converted.messages[2], 'is_error'), false,
  'Anthropic is_error must not leak to a generic OpenAI Chat upstream');

assert.throws(
  () => convertAnthropicToOpenAIRequest({
    model: 'Code-Max',
    max_tokens: 128,
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_test',
        content: 'bad value',
        is_error: 'yes',
      }],
    }],
  }),
  (error) => error instanceof ConversionError && /invalid tool_result\.is_error/.test(error.message),
  'non-boolean is_error must remain a conversion validation error',
);

console.log('anthropic tool-result fallback test passed');
