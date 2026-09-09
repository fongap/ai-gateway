#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Regression contract for Claude Code -> Anthropic Messages -> OpenAI Chat.
// Top-level `thinking`, `context_management`, and effort-only `output_config`
// are request-control settings. Generic OpenAI-compatible Chat providers have
// no portable equivalents, so the fallback accepts the narrowly validated
// forms and deliberately drops them. Anthropic thinking CONTENT blocks and
// structured output formats remain non-convertible because dropping them would
// lose request or conversation semantics.

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
  output_config: { effort: 'high' },
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
assert.equal(Object.hasOwn(converted, 'output_config'), false,
  'effort-only output_config must not leak to a generic OpenAI Chat upstream');

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
    output_config: 'invalid',
    messages: [{ role: 'user', content: 'hello' }],
  }),
  (error) => error instanceof ConversionError && /invalid output_config/.test(error.message),
  'non-object output_config must remain non-convertible',
);

assert.throws(
  () => convertAnthropicToOpenAIRequest({
    model: 'Code-Max',
    max_tokens: 1024,
    output_config: { effort: 'turbo' },
    messages: [{ role: 'user', content: 'hello' }],
  }),
  (error) => error instanceof ConversionError && /invalid output_config\.effort/.test(error.message),
  'unknown effort values must remain non-convertible',
);

assert.throws(
  () => convertAnthropicToOpenAIRequest({
    model: 'Code-Max',
    max_tokens: 1024,
    output_config: {
      format: {
        type: 'json_schema',
        schema: { type: 'object' },
      },
    },
    messages: [{ role: 'user', content: 'hello' }],
  }),
  (error) => error instanceof ConversionError && /output_config/.test(error.message),
  'structured output format must not be silently dropped on generic Chat fallback',
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

console.log('anthropic thinking/context-management/output-config fallback test passed');
