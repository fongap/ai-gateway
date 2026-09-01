// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Anthropic Messages request -> OpenAI Chat Completions request converter.

export class ConversionError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ConversionError';
    this.code = code;
  }
}

function unsupportedBlock(type) {
  throw new ConversionError(`conversion_not_supported: ${type} blocks not supported`);
}

function systemToOpenAI(system) {
  if (system === undefined || system === null) return null;
  if (typeof system === 'string') return { role: 'system', content: system };
  if (!Array.isArray(system)) return { role: 'system', content: String(system) };
  const parts = [];
  for (const block of system) {
    if (typeof block === 'string') parts.push(block);
    else if (block?.type === 'text') parts.push(block.text || '');
    else unsupportedBlock(block?.type || 'unknown');
  }
  return { role: 'system', content: parts.join('\n') };
}

function convertAssistantContent(blocks) {
  const out = { content: '' };
  const toolCalls = [];
  let pending = null;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      out.content = (out.content || '') + (block.text || '');
    } else if (block.type === 'tool_use') {
      if (!pending) {
        pending = { toolCalls: [], content: out.content || '' };
      }
      pending.toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    } else {
      unsupportedBlock(block.type);
    }
  }
  if (pending) {
    return { content: pending.content, tool_calls: pending.toolCalls };
  }
  return out;
}

function convertUserContent(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') parts.push({ type: 'text', text: block.text || '' });
    else if (block.type === 'tool_result') {
      const text = extractToolResultText(block.content);
      parts.push({ role: 'tool', tool_call_id: block.tool_use_id, content: text });
    } else {
      unsupportedBlock(block.type);
    }
  }
  return parts.length === 1 && parts[0].role === 'tool' ? parts[0] : parts;
}

function extractToolResultText(content) {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') parts.push(part);
    else if (part && typeof part === 'object' && part.type === 'text') parts.push(part.text || '');
  }
  return parts.join('\n');
}

function mapToolChoice(toolChoice) {
  if (toolChoice === undefined || toolChoice === null) return undefined;
  if (typeof toolChoice === 'string') return toolChoice;
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'tool') return { type: 'function', function: { name: toolChoice.name } };
  if (toolChoice.type === 'none') return 'none';
  unsupportedBlock(`tool_choice:${toolChoice.type}`);
}

export function convertAnthropicToOpenAIRequest(body) {
  const out = {};
  if (body.model !== undefined) out.model = body.model;
  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.top_k !== undefined) out.top_k = body.top_k;
  if (body.stream !== undefined) out.stream = body.stream;
  if (body.stop_sequences !== undefined) out.stop = body.stop_sequences;
  if (body.metadata !== undefined) out.metadata = body.metadata;
  if (body.user !== undefined) out.user = body.user;

  const messages = [];
  const systemMessage = systemToOpenAI(body.system);
  if (systemMessage) messages.push(systemMessage);

  for (const msg of body.messages || []) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'assistant', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        messages.push({ role: 'assistant', ...convertAssistantContent(msg.content) });
      } else {
        messages.push({ role: 'assistant', content: msg.content ?? '' });
      }
    } else if (msg.role === 'user') {
      const converted = convertUserContent(msg.content);
      // When a user message contains a single tool_result, convertUserContent
      // returns a flat { role: 'tool', tool_call_id, content } object that
      // must become a top-level OpenAI tool message — not the content of a
      // user message.
      if (converted && typeof converted === 'object' && !Array.isArray(converted) && converted.role === 'tool') {
        messages.push(converted);
      } else {
        messages.push({ role: 'user', content: converted });
      }
    } else if (msg.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: msg.tool_use_id, content: extractToolResultText(msg.content) });
    } else {
      unsupportedBlock(`role:${msg.role}`);
    }
  }
  out.messages = messages;

  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }
  if (body.tool_choice !== undefined) {
    out.tool_choice = mapToolChoice(body.tool_choice);
  }
  return out;
}
