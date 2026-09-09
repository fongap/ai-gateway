#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Regression contract for Claude Code -> Anthropic Messages -> OpenAI Chat.
// Top-level `thinking` and `context_management` are request-control settings.
// Generic OpenAI-compatible Chat providers have no portable equivalents, so
// the fallback accepts structurally valid objects and deliberately drops them.
// Anthropic thinking CONTENT blocks remain non-convertible because dropping
// message history would lose semantics.

import assert from 'node:assert/strict';
import {
  convertAnthropicToOpenAIRequest,
  ConversionError,
} from '../src/conversion/anthropic-to-openai.ts';

const converted = convertAnthropicToOpenAIRequest({
  model: 'Code-Max',
  max_tokens: 1024,
  thinking: { type: 'enabled', budget_tokens: 512 },
  context_management: { edits: [] },
  messages: [{ role: 'user', content: 'Reply exactly OK' }],
});

assert.equal(converted.model, 'Code-Max');
assert.equal(converted.max_tokens, 1024);
assert.deepEqual(converted.messages, [
  { role: 'user', content: 'Reply exactly OK' },
]);
assert.equal(Object.hasOwn(converted, 'thinking'), false,
  'top-level thinking must not leak to a generic OpenAI Chat upstream');
assert.equal(Object.hasOwn(converted, 'context_management'), false,
  'context_management must not leak to a generic OpenAI Chat upstream');

assert.throws(
  () => convertAnthropicToOpenAIRequest({
    model: 'Code-Max',
    max_tokens: 1024,
    context_management: 'invalid',
    messages: [{ role: 'user', content: 'hello' }],
  }),
  (error) => error instanceof ConversionError && /invalid context_management/.test(error.message),
  'non-object context_management must remain non-convertible',
);

assert.throws(
  () => convertAnthropicToOpenAIRequest({
    model: 'Code-Max',
    max_tokens: 1024,
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'reasoning history' },
        { type: 'text', text: 'answer' },
      ],
    }],
  }),
  (error) => error instanceof ConversionError && /thinking blocks not supported/.test(error.message),
  'thinking content blocks must remain non-convertible instead of being silently dropped',
);

console.log('anthropic thinking/context-management fallback test passed');
