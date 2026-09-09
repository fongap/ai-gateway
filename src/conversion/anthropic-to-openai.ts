// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Anthropic Messages request -> OpenAI Chat Completions request converter.

import { ConversionError, isRecord, assertFields, assertSampling } from './validation.ts';
export { ConversionError };

function unsupportedBlock(type: unknown): never {
  throw new ConversionError(`conversion_not_supported: ${type} blocks not supported`);
}

// `cache_control` and `metadata` are attribution / prompt-caching hints that
// have no safe generic OpenAI Chat equivalent mapping. They never change the
// generated content, so on the Anthropic -> OpenAI fallback they are accepted
// and then deliberately DROPPED (see the contract in fallback.md). This is an
// intentional drop, not an omission: the block text still reaches the upstream.
const SAFELY_IGNORABLE_FIELDS = ['cache_control'];

function systemToOpenAI(system: unknown): Record<string, unknown> | null {
  if (system === undefined || system === null) return null;
  if (typeof system === 'string') return { role: 'system', content: system };
  if (!Array.isArray(system)) unsupportedBlock('invalid system');
  const parts: string[] = [];
  for (const block of system) {
    if (typeof block === 'string') parts.push(block);
    else if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      // `cache_control` is intentionally ignored (see SAFELY_IGNORABLE_FIELDS).
      assertFields(block, ['type', 'text', ...SAFELY_IGNORABLE_FIELDS], 'system');
      parts.push(block.text);
    }
    else unsupportedBlock(isRecord(block) ? block.type : 'unknown');
  }
  return { role: 'system', content: parts.join('\n') };
}

function convertAssistantContent(blocks: unknown[]): Record<string, unknown> {
  let text = '';
  const toolCalls: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) unsupportedBlock('invalid');
    if (block.type === 'text') {
      // `cache_control` is intentionally ignored (see SAFELY_IGNORABLE_FIELDS).
      assertFields(block, ['type', 'text', ...SAFELY_IGNORABLE_FIELDS], 'assistant text');
      if (typeof block.text !== 'string') unsupportedBlock('non-text');
      text += block.text;
    } else if (block.type === 'tool_use') {
      // `cache_control` is intentionally ignored (see SAFELY_IGNORABLE_FIELDS).
      assertFields(block, ['type', 'id', 'name', 'input', ...SAFELY_IGNORABLE_FIELDS], 'tool_use');
      if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name || !isRecord(block.input)) unsupportedBlock('invalid tool_use');
      toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
    } else unsupportedBlock(block.type);
  }
  return { content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
}

function convertUserContent(blocks: unknown): string | Record<string, unknown> | Array<Record<string, unknown>> {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) unsupportedBlock('invalid user content');
  const parts: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (!isRecord(block)) unsupportedBlock('invalid');
    // `cache_control` is intentionally ignored (see SAFELY_IGNORABLE_FIELDS).
    assertFields(block, block.type === 'tool_result'
      ? ['type', 'tool_use_id', 'content', 'is_error', ...SAFELY_IGNORABLE_FIELDS]
      : ['type', 'text', ...SAFELY_IGNORABLE_FIELDS], 'user content');
    if (block.type === 'text') parts.push({ type: 'text', text: block.text || '' });
    else if (block.type === 'tool_result') {
      if (typeof block.tool_use_id !== 'string' || !block.tool_use_id) unsupportedBlock('invalid tool_result');
      if (block.is_error !== undefined && typeof block.is_error !== 'boolean') unsupportedBlock('invalid tool_result.is_error');
      const text = extractToolResultText(block.content);
      // Anthropic's `is_error` marks the tool result as failed. Generic OpenAI
      // Chat tool messages have no portable equivalent flag, so preserve the
      // exact tool result content + tool_call_id and deliberately drop only
      // the boolean marker. This keeps Claude Code tool failures routable
      // without inventing provider-specific fields or altering the error text.
      parts.push({ role: 'tool', tool_call_id: block.tool_use_id, content: text });
    } else {
      unsupportedBlock(block.type);
    }
  }
  return parts.length === 1 && parts[0].role === 'tool' ? parts[0] : parts;
}

function extractToolResultText(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) unsupportedBlock('non-text tool result');
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') parts.push(part);
    else if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      // `cache_control` is intentionally ignored (see SAFELY_IGNORABLE_FIELDS).
      assertFields(part, ['type', 'text', ...SAFELY_IGNORABLE_FIELDS], 'tool_result content');
      parts.push(part.text);
    } else unsupportedBlock('non-text tool_result');
  }
  return parts.join('\n');
}

function mapToolChoice(toolChoice: unknown): string | Record<string, unknown> | undefined {
  if (toolChoice === undefined || toolChoice === null) return undefined;
  if (typeof toolChoice === 'string') return toolChoice;
  if (!isRecord(toolChoice)) unsupportedBlock('invalid tool_choice');
  assertFields(toolChoice, ['type', 'name'], 'tool_choice');
  const tc = toolChoice;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool') return { type: 'function', function: { name: tc.name } };
  if (tc.type === 'none') return 'none';
  unsupportedBlock(`tool_choice:${tc.type}`);
}

function assertDroppableThinkingConfig(thinking: unknown): void {
  if (thinking === undefined || thinking === null) return;
  if (!isRecord(thinking)) unsupportedBlock('invalid thinking');
}

export function convertAnthropicToOpenAIRequest(body: Record<string, unknown>): Record<string, unknown> {
  // `metadata` is an Anthropic attribution field with no safe generic OpenAI
  // equivalent — different OpenAI-compatible providers disagree on `user`,
  // `metadata`, `safety_identifier`. It never changes generated content, so it
  // is accepted here and deliberately NOT forwarded to the OpenAI upstream.
  //
  // Top-level `thinking` is different: it is a request-control setting with
  // real semantics, but generic OpenAI-compatible Chat providers do not share
  // one portable reasoning-control field. For this cross-protocol fallback we
  // therefore accept a structurally valid object and deliberately DROP it so
  // Claude Code can still use Chat-only nodes. Thinking CONTENT blocks remain
  // non-convertible in convertAssistantContent/convertUserContent because
  // silently deleting message history would lose conversation semantics.
  assertFields(body, ['model', 'messages', 'system', 'max_tokens', 'temperature', 'top_p', 'stream', 'stop_sequences', 'tools', 'tool_choice', 'metadata', 'thinking'], 'request');
  assertDroppableThinkingConfig(body.thinking);
  assertSampling(body);
  if (!Array.isArray(body.messages)) unsupportedBlock('invalid messages');
  const out: Record<string, unknown> = {};
  if (body.model !== undefined) out.model = body.model;
  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stream !== undefined) out.stream = body.stream;
  if (body.stop_sequences !== undefined) out.stop = body.stop_sequences;

  const messages: Record<string, unknown>[] = [];
  const systemMessage = systemToOpenAI(body.system);
  if (systemMessage) messages.push(systemMessage);

  for (const msg of body.messages || []) {
    if (!isRecord(msg)) unsupportedBlock('invalid message');
    assertFields(msg, ['role', 'content', 'tool_use_id'], 'message');
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
      } else if (Array.isArray(converted)) {
        // Tool results must be top-level Chat messages, including parallel calls.
        let parts: Record<string, unknown>[] = [];
        const flush = () => { if (parts.length) messages.push({ role: 'user', content: parts }); parts = []; };
        for (const part of converted) {
          if (part.role === 'tool') { flush(); messages.push(part); } else parts.push(part);
        }
        flush();
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
    out.tools = body.tools.map((tool: unknown) => {
      if (!isRecord(tool)) unsupportedBlock('invalid tool');
      // `cache_control` is intentionally ignored (see SAFELY_IGNORABLE_FIELDS).
      assertFields(tool, ['name', 'description', 'input_schema', ...SAFELY_IGNORABLE_FIELDS], 'tool');
      if (typeof tool.name !== 'string' || !tool.name || !isRecord(tool.input_schema)) unsupportedBlock('invalid tool');
      return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } };
    });
  }
  if (body.tool_choice !== undefined) {
    out.tool_choice = mapToolChoice(body.tool_choice);
  }
  return out;
}
