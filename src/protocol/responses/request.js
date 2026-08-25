// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// OpenAI Responses request -> OpenAI Chat Completions request.
//
// This is the inbound half of the generic-provider conversion. It intentionally
// keeps the stateless-relay nature of ai-gateway: `previous_response_id` is
// accepted but ignored (the client supplies the full `input` items each turn),
// `store` is a no-op, and unsupported host-managed tools raise a clear error
// instead of being silently dropped.

import {
  convertResponsesToolsToChat, convertResponsesToolChoice,
  toolArgumentsToJson, isPlainObject,
} from './tools.js';
import { applyResponsesReasoning } from './reasoning.js';

export class ResponseConversionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResponseConversionError';
  }
}

export function responsesToOpenAIRequest(body, upstreamModel, env) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ResponseConversionError('Request body must be a JSON object.');
  }
  if (!body.model || typeof body.model !== 'string' || !body.model.trim()) {
    throw new ResponseConversionError('model is required and must be a non-empty string.');
  }
  if (body.input === undefined || body.input === null) {
    throw new ResponseConversionError('input is required.');
  }
  assertSupportedFields(body);

  const messages = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions });
  }
  const inputMessages = inputItemsToChatMessages(body.input);
  messages.push(...inputMessages);
  if (messages.length === 0) {
    throw new ResponseConversionError('Responses input must contain at least one user or tool item.');
  }

  const out = {
    model: upstreamModel,
    messages,
    stream: body.stream === true,
  };
  if (Number.isFinite(Number(body.max_output_tokens)) && Number(body.max_output_tokens) > 0) {
    out.max_tokens = Number(body.max_output_tokens);
  }
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Number.isFinite(Number(body.top_k))) out.top_k = Number(body.top_k);
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (body.metadata?.user_id) out.user = String(body.metadata.user_id);

  const { chatTools, unsupported } = convertResponsesToolsToChat(body.tools);
  if (unsupported.length) {
    throw new ResponseConversionError(`Unsupported tool(s): ${unsupported.join('; ')}`);
  }
  if (chatTools.length) {
    out.tools = chatTools;
    const toolChoice = convertResponsesToolChoice(body.tool_choice);
    if (toolChoice !== undefined) out.tool_choice = toolChoice;
    if (typeof body.parallel_tool_calls === 'boolean') out.parallel_tool_calls = body.parallel_tool_calls;
  }

  applyResponsesReasoning(out, body, env);
  return out;
}

function inputItemsToChatMessages(input) {
  const messages = [];
  let toolGroup = null;
  const flushToolGroup = () => {
    if (toolGroup && toolGroup.tool_calls.length) messages.push(toolGroup);
    toolGroup = null;
  };
  const items = Array.isArray(input) ? input : [input];
  for (const item of items) {
    if (typeof item === 'string') {
      flushToolGroup();
      if (item.trim()) messages.push({ role: 'user', content: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message') {
      flushToolGroup();
      const msg = messageItemToChat(item);
      if (msg) messages.push(msg);
    } else if (item.type === 'function_call') {
      if (item.call_id === undefined && item.id) item.call_id = item.id;
      if (!toolGroup) toolGroup = { role: 'assistant', content: null, tool_calls: [] };
      toolGroup.tool_calls.push({
        id: item.call_id || randomCallId(),
        type: 'function',
        function: {
          name: item.name || 'unknown_tool',
          arguments: toolArgumentsToJson(item.arguments),
        },
      });
    } else if (item.type === 'function_call_output') {
      flushToolGroup();
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id || '',
        content: stringifyOutput(item.output),
      });
    } else if (item.type === 'reasoning') {
      // Prior-turn reasoning is a model-internal trace; not used by the model.
      flushToolGroup();
    }
  }
  flushToolGroup();
  return messages;
}

function messageItemToChat(item) {
  const role = String(item.role || '').toLowerCase();
  if (role === 'system') {
    const text = extractPartsText(item.content);
    return text ? { role: 'system', content: text } : null;
  }
  if (role !== 'user' && role !== 'assistant') return null;
  const content = convertMessageParts(item.content, role);
  return { role, content };
}

function convertMessageParts(content, role) {
  const parts = Array.isArray(content) ? content : [];
  const textParts = [];
  const richParts = [];
  let hasRich = false;
  for (const part of parts) {
    const converted = messagePartToChat(part);
    if (!converted) continue;
    if (converted.type === 'text') textParts.push(converted.text);
    else hasRich = true;
    richParts.push(converted);
  }
  if (!richParts && !textParts.length) {
    return role === 'assistant' ? '' : '';
  }
  if (!hasRich) return textParts.join('');
  return richParts;
}

function messagePartToChat(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
    return { type: 'text', text: String(part.text || '') };
  }
  if (part.type === 'input_image' || part.type === 'image_url') {
    const url = part.image_url;
    if (typeof url === 'string' && url) return { type: 'image_url', image_url: { url } };
    if (isPlainObject(url) && typeof url.url === 'string' && url.url) {
      return { type: 'image_url', image_url: { url: url.url, ...(url.detail ? { detail: url.detail } : {}) } };
    }
    return { type: 'text', text: '[Unsupported image part omitted]' };
  }
  return { type: 'text', text: `[Unsupported content part ${part.type || 'unknown'} omitted]` };
}

function extractPartsText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (typeof part === 'string') text += part;
    else if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') text += part.text || '';
  }
  return text;
}

function stringifyOutput(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function randomCallId() {
  return `call_${crypto.randomUUID().replace(/-/g, '')}`;
}

// Fields that a generic chat-completions upstream cannot represent losslessly.
// Rather than silently mis-interpreting them, we surface a clear 400 naming the
// exact fields (mirrors free-claude-code's refuse-rather-than-drop approach).
function assertSupportedFields(body) {
  const unsupported = [];
  if (body.mcp_servers && Array.isArray(body.mcp_servers) && body.mcp_servers.length) {
    unsupported.push('mcp_servers');
  }
  if (body.extra_body !== undefined && body.extra_body !== null) {
    unsupported.push('extra_body');
  }
  if (!isNoopContextManagement(body.context_management)) {
    unsupported.push('context_management');
  }
  if (body.output_config && isPlainObject(body.output_config)) {
    for (const key of Object.keys(body.output_config)) {
      if (key !== 'effort') unsupported.push(`output_config.${key}`);
    }
  }
  if (unsupported.length) {
    throw new ResponseConversionError(
      `OpenAI Responses cannot represent these fields without data loss: ${unsupported.join(', ')}.`,
    );
  }
}

function isNoopContextManagement(value) {
  if (value === undefined || value === null) return true;
  if (!isPlainObject(value)) return false;
  if (Object.keys(value).length === 0) return true;
  // Anthropic's `clear_thinking_20251015` keep-all edit is a no-op for a model
  // that does not persist thinking state; anything else cannot be represented.
  const edits = value.edits;
  if (!Array.isArray(edits)) return false;
  return edits.length > 0 && edits.every((edit) => isPlainObject(edit)
    && edit.type === 'clear_thinking_20251015' && edit.keep === 'all');
}
