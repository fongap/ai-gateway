// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// OpenAI Chat Completions response -> Anthropic Messages response converter.

import { ConversionError } from './anthropic-to-openai.js';

function mapFinishReason(reason) {
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

export function convertOpenAIUsageToAnthropic(usage) {
  if (!usage || typeof usage !== 'object') return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: Number(usage.prompt_tokens ?? 0) || 0,
    output_tokens: Number(usage.completion_tokens ?? 0) || 0,
  };
}

function parseToolArguments(argumentsString) {
  if (!argumentsString) return {};
  if (typeof argumentsString !== 'string') return argumentsString ?? {};
  try {
    const parsed = JSON.parse(argumentsString);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return { _raw: argumentsString };
  } catch {
    return { _raw: argumentsString };
  }
}

export function convertOpenAIToAnthropicResponse(data) {
  if (!data || typeof data !== 'object') {
    throw new ConversionError('conversion_invalid_response', 'OpenAI response is not an object');
  }
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const choice = choices[0] || {};
  const message = choice.message || {};
  const content = [];

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
    id: data.id,
    type: 'message',
    role: 'assistant',
    model: data.model,
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: convertOpenAIUsageToAnthropic(data.usage),
  };
}
