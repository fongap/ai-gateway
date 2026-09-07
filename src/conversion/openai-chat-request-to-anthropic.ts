// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// OpenAI Chat Completions REQUEST -> Anthropic Messages REQUEST converter.
//
// This is an INDEPENDENT request converter. It does NOT import or reuse the
// existing response converter (openai-to-anthropic.ts) or the stream
// converter (stream-converter.ts). Request and response conversions have
// distinct concerns and must not share mutable logic.
//
// Supports a minimal, safe subset of OpenAI Chat Completions that maps
// cleanly onto Anthropic Messages. Anything that cannot be mapped without
// semantic loss is rejected with ConversionError(code =
// "conversion_not_supported: ...") so the caller can return a client-protocol
// error envelope.

import { ConversionError } from './anthropic-to-openai.ts';

export { ConversionError };

// Single default policy for max_tokens. Anthropic REQUIRES max_tokens on
// /v1/messages; OpenAI Chat Completions treats it as optional. When the
// client omits it we apply this single, named default rather than scattering
// magic numbers throughout the converter. Exported so tests/docs share one fact.
export const DEFAULT_MAX_TOKENS = 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Anthropic tool_result MUST live inside a user message. We merge one or more
// consecutive tool messages into a single user message containing tool_result
// blocks.
type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

function mapToolChoice(toolChoice: unknown): Record<string, unknown> | string {
  if (toolChoice === undefined || toolChoice === null) return toolChoice as never;
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'none' || toolChoice === 'auto') return { type: toolChoice };
    if (toolChoice === 'required') return { type: 'any' };
    throw new ConversionError(`conversion_not_supported: tool_choice string "${toolChoice}" is not supported`);
  }
  if (isRecord(toolChoice)) {
    if (toolChoice.type === 'none' || toolChoice.type === 'auto' || toolChoice.type === 'any') return { type: toolChoice.type };
    if (toolChoice.type === 'tool') {
      if (!toolChoice.name || typeof toolChoice.name !== 'string') {
        throw new ConversionError('conversion_not_supported: tool_choice tool.name is required');
      }
      return { type: 'tool', name: toolChoice.name };
    }
    // Non-streaming OpenAI shape { type: "function", function: { name } }
    if (toolChoice.type === 'function' && isRecord(toolChoice.function)) {
      return { type: 'tool', name: (toolChoice.function as Record<string, unknown>).name };
    }
    throw new ConversionError(`conversion_not_supported: tool_choice type "${String(toolChoice.type)}" is not supported`);
  }
  throw new ConversionError('conversion_not_supported: tool_choice must be a string or object');
}

function convertUserContent(content: unknown): string | Array<Record<string, unknown>> {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    throw new ConversionError('conversion_not_supported: user content must be a string or parts array');
  }
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part });
      continue;
    }
    if (!isRecord(part)) {
      throw new ConversionError('conversion_not_supported: user content part is not an object');
    }
    if (part.type === 'text') {
      parts.push({ type: 'text', text: typeof part.text === 'string' ? part.text : '' });
    } else if (part.type === 'image_url') {
      const iu = isRecord(part.image_url) ? part.image_url : {};
      const url = typeof iu.url === 'string' ? iu.url : '';
      if (!url) throw new ConversionError('conversion_not_supported: image_url.url is required');
      parts.push({ type: 'image', source: { type: 'url', url } });
    } else if (part.type === 'input_audio' || part.type === 'file') {
      throw new ConversionError(`conversion_not_supported: content type "${part.type}" is not supported`);
    } else {
      throw new ConversionError(`conversion_not_supported: unsupported user content part type "${String(part.type)}"`);
    }
  }
  return parts;
}

function parseAssistantArguments(argumentsField: unknown): Record<string, unknown> {
  if (argumentsField === undefined || argumentsField === null) return {};
  if (typeof argumentsField === 'string') {
    if (!argumentsField) return {};
    try {
      const parsed = JSON.parse(argumentsField);
      return isRecord(parsed) ? parsed : { _raw: argumentsField };
    } catch {
      return { _raw: argumentsField };
    }
  }
  if (isRecord(argumentsField)) return argumentsField;
  return { _raw: argumentsField };
}

function convertAssistantMessage(msg: Record<string, unknown>): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (typeof msg.content === 'string') {
    if (msg.content) content.push({ type: 'text', text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (isRecord(part) && part.type === 'text') {
        content.push({ type: 'text', text: typeof part.text === 'string' ? part.text : '' });
      } else {
        throw new ConversionError('conversion_not_supported: assistant content parts must be type "text"');
      }
    }
  } else if (msg.content !== undefined && msg.content !== null) {
    throw new ConversionError('conversion_not_supported: assistant content must be a string or text parts');
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (!isRecord(tc)) {
        throw new ConversionError('conversion_not_supported: tool_calls entry is not an object');
      }
      if (tc.type !== 'function') {
        throw new ConversionError('conversion_not_supported: only function tool_calls are supported');
      }
      const fn = isRecord(tc.function) ? tc.function : {};
      const id = typeof tc.id === 'string' ? tc.id : '';
      const name = typeof fn.name === 'string' ? fn.name : '';
      if (!id) throw new ConversionError('conversion_not_supported: tool_call id is required');
      if (!name) throw new ConversionError('conversion_not_supported: tool_call function.name is required');
      const input = parseAssistantArguments(fn.arguments);
      content.push({ type: 'tool_use', id, name, input });
    }
  }

  return { role: 'assistant', content };
}

function extractToolResultText(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') parts.push(part);
    else if (isRecord(part) && part.type === 'text') parts.push(typeof part.text === 'string' ? part.text : '');
    else if (part !== null && typeof part === 'object') {
      throw new ConversionError('conversion_not_supported: non-text tool_result content part');
    }
  }
  return parts.join('\n');
}

function convertToolMessage(msg: Record<string, unknown>): ToolResultBlock {
  const toolUseId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
  if (!toolUseId) throw new ConversionError('conversion_not_supported: tool message missing tool_call_id');
  const block: ToolResultBlock = {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: extractToolResultText(msg.content),
  };
  if (typeof msg.status === 'string' && msg.status !== 'success') block.is_error = true;
  return block;
}

// Converts an OpenAI Chat Completions request body into an Anthropic Messages
// request body. Rejects fields that cannot be converted without semantic loss.
export function convertOpenAIChatRequestToAnthropic(body: Record<string, unknown>): Record<string, any> {
  if (!isRecord(body)) {
    throw new ConversionError('conversion_not_supported: request body is not an object');
  }
  const out: Record<string, any> = {};

  if (body.model !== undefined) out.model = body.model;
  if (!out.model || typeof out.model !== 'string' || !out.model.trim()) {
    throw new ConversionError('conversion_not_supported: model is required');
  }

  // max_tokens: single default policy when omitted.
  if (body.max_tokens !== undefined) {
    const mt = Number(body.max_tokens);
    if (!Number.isFinite(mt) || mt <= 0) {
      throw new ConversionError('conversion_not_supported: max_tokens must be a positive number');
    }
    out.max_tokens = Math.round(mt);
  } else {
    out.max_tokens = DEFAULT_MAX_TOKENS;
  }

  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stream !== undefined) out.stream = body.stream;

  // stop (string | string[]) -> stop_sequences (string[]).
  if (body.stop !== undefined) {
    if (typeof body.stop === 'string') {
      out.stop_sequences = [body.stop];
    } else if (Array.isArray(body.stop) && body.stop.every((s) => typeof s === 'string')) {
      out.stop_sequences = body.stop;
    } else {
      throw new ConversionError('conversion_not_supported: stop must be a string or string[]');
    }
  }

  // tools: tools[].function.parameters -> tools[].input_schema.
  if (Array.isArray(body.tools)) {
    const tools: Array<Record<string, any>> = [];
    for (const tool of body.tools) {
      if (!isRecord(tool)) throw new ConversionError('conversion_not_supported: tools entry is not an object');
      if (tool.type !== 'function') throw new ConversionError('conversion_not_supported: only function tools are supported');
      const fn = isRecord(tool.function) ? tool.function : null;
      if (!fn || !fn.name || typeof fn.name !== 'string') {
        throw new ConversionError('conversion_not_supported: tool.function.name is required');
      }
      const result: Record<string, any> = { name: fn.name };
      if (typeof fn.description === 'string') result.description = fn.description;
      const inputSchema = isRecord(fn.parameters) ? fn.parameters : {};
      result.input_schema = { ...inputSchema, type: 'object' };
      tools.push(result);
    }
    out.tools = tools;
  }

  // tool_choice mapping:
  //   auto    -> { type: 'auto' }
  //   required-> { type: 'any' }
  //   none    -> { type: 'none' }
  //   { type: 'tool', name } / { type: 'function', function } -> { type: 'tool', name }
  if (body.tool_choice !== undefined) {
    out.tool_choice = mapToolChoice(body.tool_choice);
  }

  // system: merge top-level system + developer messages into the Anthropic
  // top-level `system` field (a string or an array of text blocks).
  const systemParts: string[] = [];
  if (typeof body.system === 'string' && body.system) systemParts.push(body.system);
  if (Array.isArray(body.developer)) {
    for (const d of body.developer) {
      if (typeof d === 'string') systemParts.push(d);
      else if (isRecord(d) && typeof d.content === 'string' && d.content) systemParts.push(d.content);
    }
  }

  // Build messages from the OpenAI `messages` array.
  if (!Array.isArray(body.messages)) {
    throw new ConversionError('conversion_not_supported: messages must be an array');
  }

  const messages: Array<Record<string, any>> = [];
  const pendingToolResults: ToolResultBlock[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    // Anthropic tool_result MUST be in a user message.
    messages.push({ role: 'user', content: [...pendingToolResults] });
    pendingToolResults.length = 0;
  };

  for (const msg of body.messages) {
    if (!isRecord(msg)) throw new ConversionError('conversion_not_supported: messages entry is not an object');
    const role = msg.role;
    if (role === 'system' || role === 'developer') {
      // Anthropic doesn't accept system/developer as message roles; accumulate
      // into the top-level system field (content may be string or parts array).
      if (typeof msg.content === 'string' && msg.content) systemParts.push(msg.content);
      else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') systemParts.push(part.text);
          else if (typeof part === 'string') systemParts.push(part);
        }
      }
      continue;
    }

    // Any pending tool results belong to the preceding assistant tool calls;
    // emit them in a user message before the next non-tool message.
    if (role !== 'tool') flushToolResults();

    if (role === 'user') {
      messages.push({ role: 'user', content: convertUserContent(msg.content) });
    } else if (role === 'assistant') {
      messages.push(convertAssistantMessage(msg));
    } else if (role === 'tool') {
      pendingToolResults.push(convertToolMessage(msg));
    } else {
      throw new ConversionError(`conversion_not_supported: role "${String(role)}" is not supported`);
    }
  }

  flushToolResults();

  // Apply accumulated system content (string when one, array of text blocks when >1).
  if (systemParts.length === 1) out.system = systemParts[0];
  else if (systemParts.length > 1) {
    out.system = systemParts.map((s) => ({ type: 'text', text: s }));
  }

  if (messages.length === 0) throw new ConversionError('conversion_not_supported: messages array is empty');
  out.messages = messages;

  return out;
}
