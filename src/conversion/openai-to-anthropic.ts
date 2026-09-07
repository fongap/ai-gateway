// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// OpenAI Chat Completions response -> Anthropic Messages response converter.

import { ConversionError } from './anthropic-to-openai.ts';
import { parseToolArguments } from './validation.ts';

function mapFinishReason(reason: unknown): string {
  switch (reason) {
    case 'stop':
    case 'content_filter':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}

export function convertOpenAIUsageToAnthropic(usage: unknown): { input_tokens: number, output_tokens: number } {
  if (!usage || typeof usage !== 'object') return { input_tokens: 0, output_tokens: 0 };
  const u = usage as Record<string, unknown>;
  return {
    input_tokens: Number(u.prompt_tokens ?? 0) || 0,
    output_tokens: Number(u.completion_tokens ?? 0) || 0,
  };
}

export function convertOpenAIToAnthropicResponse(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') {
    throw new ConversionError('conversion_invalid_response', 'OpenAI response is not an object');
  }
  const d = data as Record<string, unknown>;
  const choices = Array.isArray(d.choices) ? d.choices : [];
  const choice = choices[0] || {};
  const message = choice.message || {};
  const content: Record<string, unknown>[] = [];

  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content });
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    for (const call of message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.function?.name || '',
        input: parseToolArguments(call.function?.arguments),
      });
    }
  }

  return {
    id: d.id,
    type: 'message',
    role: 'assistant',
    model: d.model,
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: convertOpenAIUsageToAnthropic(d.usage),
  };
}
