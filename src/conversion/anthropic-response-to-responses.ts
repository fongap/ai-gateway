// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Anthropic Messages RESPONSE -> OpenAI Responses RESPONSE converter
// (R0.6 / Codex path).
//
// This is an INDEPENDENT response converter. It does NOT import or reuse the
// existing response converters (openai-to-anthropic.ts or
// anthropic-response-to-openai-chat.ts). The Responses object shape is
// distinct (`output[]`, message item / function_call item, status field)
// and must be assembled separately.
//
// Scope is the same as the request converter: the Codex subset only. We
// do not silently drop fields; lossless conversion errors throw
// ConversionError with a `conversion_not_supported:` code.

import { ConversionError } from './anthropic-to-openai.ts';

export { ConversionError };

function mapStopReasonToStatus(stopReason: unknown): 'completed' | 'failed' | 'incomplete' {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'tool_use':
      return 'completed';
    case 'max_tokens':
      return 'incomplete';
    case 'refusal':
      return 'failed';
    default:
      return 'completed';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mapUsage(usage: unknown): { input_tokens: number, output_tokens: number, total_tokens: number } {
  const u = isRecord(usage) ? usage : {};
  const input = Number(u.input_tokens ?? 0) || 0;
  const output = Number(u.output_tokens ?? 0) || 0;
  const total = Number(u.total_tokens ?? (input + output)) || (input + output);
  return { input_tokens: input, output_tokens: output, total_tokens: total };
}

// Build a Responses output[] from Anthropic content blocks. The R0.6 subset
// supports text and tool_use only — thinking/image/audio blocks are rejected
// rather than silently dropped.
function buildOutputItems(content: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  // Responses allows multiple `message` items + `function_call` items. We
  // group consecutive text blocks into a single message item; tool_use
  // blocks each become their own function_call item.
  let currentText: string | null = null;
  const flushText = () => {
    if (currentText === null) return;
    items.push({
      id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: currentText, annotations: [] }],
    });
    currentText = null;
  };
  for (const block of content) {
    const type = block.type;
    if (type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      currentText = currentText === null ? text : currentText + text;
      continue;
    }
    if (type === 'tool_use') {
      flushText();
      const id = typeof block.id === 'string' ? block.id : '';
      const name = typeof block.name === 'string' ? block.name : '';
      if (!id) throw new ConversionError('conversion_not_supported: tool_use.id is required');
      if (!name) throw new ConversionError('conversion_not_supported: tool_use.name is required');
      let argsString = '{}';
      try { argsString = JSON.stringify(block.input ?? {}); } catch { argsString = '{}'; }
      items.push({
        id: `fc_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function_call',
        status: 'completed',
        call_id: id,
        name,
        arguments: argsString,
      });
      continue;
    }
    // Thinking / image / audio / server_tool_use etc. are not lossless on
    // the Responses side — reject rather than silently drop.
    throw new ConversionError(`conversion_not_supported: response content type "${String(type)}" cannot be losslessly represented as OpenAI Responses`);
  }
  flushText();
  return items;
}

// Convert an Anthropic Messages response body to an OpenAI Responses
// response body. Throws ConversionError on inputs that cannot be losslessly
// represented.
export function convertAnthropicResponseToResponses(data: unknown, options: { id?: string, createdAt?: number } = {}): Record<string, any> {
  if (!isRecord(data)) {
    throw new ConversionError('conversion_not_supported: Anthropic response is not an object');
  }
  const id = options.id || (typeof data.id === 'string' ? data.id : `resp_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`);
  const model = typeof data.model === 'string' ? data.model : '';
  const stopReason = data.stop_reason;
  const content = Array.isArray(data.content) ? data.content : [];
  const status = mapStopReasonToStatus(stopReason);
  const output = buildOutputItems(content as Array<Record<string, unknown>>);

  return {
    id,
    object: 'response',
    created_at: options.createdAt ?? 1,
    status,
    model,
    output,
    usage: mapUsage(data.usage),
  };
}
