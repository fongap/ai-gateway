// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Anthropic Messages RESPONSE -> OpenAI Chat Completions RESPONSE converter.
//
// This is an INDEPENDENT response converter. It does NOT import or reuse the
// existing reverse-direction converter (openai-to-anthropic.ts) or the stream
// converter (stream-converter.ts). Response and stream conversions have
// distinct concerns and must not share mutable logic.
//
// Supported Anthropic response surface:
//   text, tool_use, usage, model, id, stop_reason (and stop_sequence).
// Anything else (thinking, image, audio, server_tool_use, citations, ...)
// produces a conversion_not_supported error rather than silent loss.

import { ConversionError } from './anthropic-to-openai.ts';

export { ConversionError };

// Map Anthropic stop_reason -> OpenAI Chat finish_reason (R0.2 contract).
//   end_turn              -> stop
//   max_tokens            -> length
//   tool_use              -> tool_calls
//   stop_sequence         -> stop
//   refusal / pause_turn  -> stop (conservative; OpenAI has no equivalent)
//   anything else         -> stop (last-resort safe default)
function mapStopReason(stopReason: unknown): string {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'refusal':
    case 'pause_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Anthropic tool input is a JSON object; OpenAI stores tool_call arguments as
// a JSON-encoded string. We re-encode the object back to a string here so the
// client sees the same shape that the Anthropic API would have produced.
function stringifyToolInput(input: unknown): string {
  if (input === undefined || input === null) return '{}';
  try {
    return JSON.stringify(input);
  } catch {
    return '{}';
  }
}

function buildAssistantMessage(content: Array<Record<string, unknown>>): {
  content: string;
  tool_calls?: Array<{ id: string, type: 'function', function: { name: string, arguments: string } }>;
} {
  let text = '';
  const toolCalls: Array<{ id: string, type: 'function', function: { name: string, arguments: string } }> = [];
  for (const block of content) {
    const type = block?.type;
    if (type === 'text') {
      if (typeof block.text === 'string') text += block.text;
    } else if (type === 'tool_use') {
      const id = isString(block.id) ? block.id : '';
      const name = isString(block.name) ? block.name : '';
      if (!id) throw new ConversionError('conversion_not_supported: tool_use.id is required');
      if (!name) throw new ConversionError('conversion_not_supported: tool_use.name is required');
      toolCalls.push({ id, type: 'function', function: { name, arguments: stringifyToolInput(block.input) } });
    } else {
      // Thinking, redacted_thinking, refusal, server_tool_use, image, audio,
      // document, etc. — none of these have a lossless OpenAI Chat equivalent.
      // R0.2 contract: do NOT silently drop fields.
      throw new ConversionError(`conversion_not_supported: response content type "${String(type)}" cannot be losslessly represented as OpenAI Chat`);
    }
  }
  const msg: {
    content: string;
    tool_calls?: Array<{ id: string, type: 'function', function: { name: string, arguments: string } }>;
  } = { content: text };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  return msg;
}

// Convert Anthropic usage to OpenAI Chat usage (R0.2 contract).
//   input_tokens  -> prompt_tokens
//   output_tokens -> completion_tokens
//   total_tokens  -> input_tokens + output_tokens  (computed when missing)
function mapUsage(usage: unknown): { prompt_tokens: number, completion_tokens: number, total_tokens: number } {
  const u = isRecord(usage) ? usage : {};
  const input = Number((u as Record<string, unknown>).input_tokens ?? 0) || 0;
  const output = Number((u as Record<string, unknown>).output_tokens ?? 0) || 0;
  const total = Number((u as Record<string, unknown>).total_tokens ?? (input + output)) || (input + output);
  return { prompt_tokens: input, completion_tokens: output, total_tokens: total };
}

// Convert an Anthropic Messages response body to an OpenAI Chat Completions
// response body. Throws ConversionError on inputs that cannot be losslessly
// represented.
export function convertAnthropicResponseToOpenAIChat(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) {
    throw new ConversionError('conversion_not_supported: Anthropic response is not an object');
  }
  const id = isString(data.id) ? data.id : `chatcmpl-${Date.now().toString(36)}`;
  const model = isString(data.model) ? data.model : '';
  const stopReason = (data as Record<string, unknown>).stop_reason;
  const content = Array.isArray(data.content) ? data.content : [];
  const message = buildAssistantMessage(content as Array<Record<string, unknown>>);

  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', ...message },
      finish_reason: mapStopReason(stopReason),
    }],
    usage: mapUsage((data as Record<string, unknown>).usage),
  };
}
