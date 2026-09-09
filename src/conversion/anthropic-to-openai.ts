// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Anthropic Messages request -> OpenAI Chat Completions request converter.

import { ConversionError, isRecord, assertFields, assertSampling } from './validation.ts';
export { ConversionError };

function unsupportedBlock(type: unknown): never {
  throw new ConversionError(`conversion_not_supported: ${type} blocks not supported`);
}

// Anthropic-only request hints with no safe generic OpenAI Chat equivalent.
// They are accepted only where explicitly validated below, then deliberately
// dropped. Content-bearing fields are never included in this list.
const SAFELY_IGNORABLE_FIELDS = ['cache_control'];
const TOOL_HINT_FIELDS = [
  'cache_control',
  'allowed_callers',
  'defer_loading',
  'strict',
  'input_examples',
  'eager_input_streaming',
];

function systemToOpenAI(system: unknown): Record<string, unknown> | null {
  if (system === undefined || system === null) return null;
  if (typeof system === 'string') return { role: 'system', content: system };
  if (!Array.isArray(system)) unsupportedBlock('invalid system');
  const parts: string[] = [];
  for (const block of system) {
    if (typeof block === 'string') parts.push(block);
    else if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      assertFields(block, ['type', 'text', ...SAFELY_IGNORABLE_FIELDS], 'system');
      parts.push(block.text);
    } else unsupportedBlock(isRecord(block) ? block.type : 'unknown');
  }
  return { role: 'system', content: parts.join('\n') };
}

function midConversationSystemToOpenAI(system: unknown): Record<string, unknown> | null {
  const converted = systemToOpenAI(system);
  if (!converted) return null;
  // Several OpenAI-compatible providers reject `role: system` after the first
  // message. Mid-conversation system instructions therefore degrade to a user
  // message at the same history position. This preserves instruction text and
  // chronology while avoiding a provider-specific "system must be first" 400.
  return { role: 'user', content: converted.content };
}

function assertDroppableThinkingBlock(block: Record<string, unknown>): void {
  if (block.type === 'thinking') {
    assertFields(block, ['type', 'thinking', 'signature'], 'thinking');
    if (typeof block.thinking !== 'string' || typeof block.signature !== 'string') {
      unsupportedBlock('invalid thinking');
    }
    return;
  }
  if (block.type === 'redacted_thinking') {
    assertFields(block, ['type', 'data'], 'redacted_thinking');
    if (typeof block.data !== 'string') unsupportedBlock('invalid redacted_thinking');
    return;
  }
  unsupportedBlock(block.type);
}

function assertDroppableAdvisorHistoryBlock(block: Record<string, unknown>): void {
  if (block.type === 'server_tool_use') {
    assertFields(block, ['type', 'id', 'name', 'input', 'caller'], 'server_tool_use');
    if (block.name !== 'advisor' || typeof block.id !== 'string' || !block.id || !isRecord(block.input)) {
      unsupportedBlock('server_tool_use');
    }
    return;
  }
  if (block.type === 'advisor_tool_result') {
    assertFields(block, ['type', 'tool_use_id', 'content', ...SAFELY_IGNORABLE_FIELDS], 'advisor_tool_result');
    if (typeof block.tool_use_id !== 'string' || !block.tool_use_id || !isRecord(block.content)) {
      unsupportedBlock('invalid advisor_tool_result');
    }
    return;
  }
  unsupportedBlock(block.type);
}

function convertAssistantContent(blocks: unknown[]): Record<string, unknown> {
  let text = '';
  const toolCalls: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) unsupportedBlock('invalid');
    if (block.type === 'text') {
      assertFields(block, ['type', 'text', ...SAFELY_IGNORABLE_FIELDS], 'assistant text');
      if (typeof block.text !== 'string') unsupportedBlock('non-text');
      text += block.text;
    } else if (block.type === 'tool_use') {
      // `caller` / `toolset_name` describe Anthropic-side invocation metadata.
      // The client tool call itself remains fully representable in OpenAI Chat.
      assertFields(block, ['type', 'id', 'name', 'input', 'caller', 'toolset_name', ...SAFELY_IGNORABLE_FIELDS], 'tool_use');
      if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name || !isRecord(block.input)) unsupportedBlock('invalid tool_use');
      toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      // Generic OpenAI Chat has no portable hidden-reasoning history field.
      // Preserve the visible assistant text/tool calls and explicitly drop only
      // Anthropic's opaque/private reasoning blocks.
      assertDroppableThinkingBlock(block);
    } else if (block.type === 'server_tool_use' || block.type === 'advisor_tool_result') {
      // Claude Code can carry Anthropic's server-side advisor orchestration in
      // history. Chat-only upstreams cannot execute/decrypt it, so the fallback
      // drops the advisor-internal blocks while preserving the visible answer.
      assertDroppableAdvisorHistoryBlock(block);
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
    assertFields(block, block.type === 'tool_result'
      ? ['type', 'tool_use_id', 'content', 'is_error', ...SAFELY_IGNORABLE_FIELDS]
      : ['type', 'text', ...SAFELY_IGNORABLE_FIELDS], 'user content');
    if (block.type === 'text') parts.push({ type: 'text', text: block.text || '' });
    else if (block.type === 'tool_result') {
      if (typeof block.tool_use_id !== 'string' || !block.tool_use_id) unsupportedBlock('invalid tool_result');
      if (block.is_error !== undefined && typeof block.is_error !== 'boolean') unsupportedBlock('invalid tool_result.is_error');
      const text = extractToolResultText(block.content);
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
      assertFields(part, ['type', 'text', ...SAFELY_IGNORABLE_FIELDS], 'tool_result content');
      parts.push(part.text);
    } else unsupportedBlock('non-text tool_result');
  }
  return parts.join('\n');
}

function mapToolChoice(toolChoice: unknown, droppedToolNames: Set<string>): string | Record<string, unknown> | undefined {
  if (toolChoice === undefined || toolChoice === null) return undefined;
  if (typeof toolChoice === 'string') return toolChoice;
  if (!isRecord(toolChoice)) unsupportedBlock('invalid tool_choice');
  assertFields(toolChoice, ['type', 'name', 'disable_parallel_tool_use'], 'tool_choice');
  if (toolChoice.disable_parallel_tool_use !== undefined && typeof toolChoice.disable_parallel_tool_use !== 'boolean') {
    unsupportedBlock('invalid tool_choice.disable_parallel_tool_use');
  }
  const tc = toolChoice;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool') {
    if (typeof tc.name !== 'string' || !tc.name) unsupportedBlock('invalid tool_choice.name');
    if (droppedToolNames.has(tc.name)) {
      throw new ConversionError(`conversion_not_supported: tool_choice references Anthropic-only server tool ${tc.name}`);
    }
    return { type: 'function', function: { name: tc.name } };
  }
  if (tc.type === 'none') return 'none';
  unsupportedBlock(`tool_choice:${tc.type}`);
}

function assertDroppableThinkingConfig(thinking: unknown): void {
  if (thinking === undefined || thinking === null) return;
  if (!isRecord(thinking)) unsupportedBlock('invalid thinking');
}

function assertDroppableContextManagementConfig(contextManagement: unknown): void {
  if (contextManagement === undefined || contextManagement === null) return;
  if (!isRecord(contextManagement)) unsupportedBlock('invalid context_management');
}

function assertDroppableCacheControl(cacheControl: unknown): void {
  if (cacheControl === undefined || cacheControl === null) return;
  if (!isRecord(cacheControl)) unsupportedBlock('invalid cache_control');
}

function assertDroppableOutputConfig(outputConfig: unknown): void {
  if (outputConfig === undefined || outputConfig === null) return;
  if (!isRecord(outputConfig)) unsupportedBlock('invalid output_config');

  // Claude Code uses `output_config.effort` to control reasoning depth. Generic
  // OpenAI-compatible Chat providers have no portable equivalent, so a valid
  // effort-only config is accepted and deliberately dropped on fallback.
  // Structured output remains non-convertible because dropping a schema would
  // change the requested response semantics.
  assertFields(outputConfig, ['effort'], 'output_config');
  if (outputConfig.effort === undefined || outputConfig.effort === null) return;
  if (typeof outputConfig.effort !== 'string'
    || !['low', 'medium', 'high', 'xhigh', 'max'].includes(outputConfig.effort)) {
    unsupportedBlock('invalid output_config.effort');
  }
}

function isAdvisorTool(tool: Record<string, unknown>): boolean {
  return tool.type === 'advisor_20260301' && tool.name === 'advisor';
}

function assertDroppableAdvisorTool(tool: Record<string, unknown>): void {
  assertFields(tool, [
    'type', 'name', 'model', 'max_uses', 'max_tokens', 'caching',
    ...TOOL_HINT_FIELDS,
  ], 'advisor tool');
  if (tool.type !== 'advisor_20260301' || tool.name !== 'advisor' || typeof tool.model !== 'string' || !tool.model) {
    unsupportedBlock('invalid advisor tool');
  }
}

export function convertAnthropicToOpenAIRequest(body: Record<string, unknown>): Record<string, unknown> {
  // This converter intentionally supports the Claude Code request-control
  // envelope that can be safely degraded onto generic OpenAI Chat. Provider-
  // specific control hints are validated then dropped. Visible text and client
  // tool calls/results are preserved. Top-level system stays first; later
  // system instructions are downgraded to user-role messages in place because
  // generic providers do not consistently allow system messages mid-history.
  // Semantic features with no safe degradation (for example structured output)
  // remain hard conversion errors.
  assertFields(body, [
    'model', 'messages', 'system', 'max_tokens', 'temperature', 'top_p',
    'stream', 'stop_sequences', 'tools', 'tool_choice', 'metadata', 'thinking',
    'context_management', 'output_config', 'cache_control',
  ], 'request');
  assertDroppableThinkingConfig(body.thinking);
  assertDroppableContextManagementConfig(body.context_management);
  assertDroppableOutputConfig(body.output_config);
  assertDroppableCacheControl(body.cache_control);
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
    assertFields(msg, ['role', 'content', 'tool_use_id', 'output_config'], 'message');
    if (msg.role !== 'system' && msg.output_config !== undefined) {
      throw new ConversionError('conversion_not_supported: message.output_config is only supported on role:system');
    }

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
      if (converted && typeof converted === 'object' && !Array.isArray(converted) && converted.role === 'tool') {
        messages.push(converted);
      } else if (Array.isArray(converted)) {
        let parts: Record<string, unknown>[] = [];
        const flush = () => { if (parts.length) messages.push({ role: 'user', content: parts }); parts = []; };
        for (const part of converted) {
          if (part.role === 'tool') { flush(); messages.push(part); } else parts.push(part);
        }
        flush();
      } else {
        messages.push({ role: 'user', content: converted });
      }
    } else if (msg.role === 'system') {
      // Mid-conversation effort changes are Anthropic-only hints. The text is
      // preserved at the same point but downgraded to user role for broad
      // OpenAI-compatible provider support.
      assertDroppableOutputConfig(msg.output_config);
      const midConversationSystem = midConversationSystemToOpenAI(msg.content);
      if (midConversationSystem) messages.push(midConversationSystem);
    } else if (msg.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: msg.tool_use_id, content: extractToolResultText(msg.content) });
    } else {
      unsupportedBlock(`role:${msg.role}`);
    }
  }
  out.messages = messages;

  const droppedToolNames = new Set<string>();
  if (Array.isArray(body.tools)) {
    const convertedTools: Record<string, unknown>[] = [];
    for (const rawTool of body.tools) {
      if (!isRecord(rawTool)) unsupportedBlock('invalid tool');
      if (isAdvisorTool(rawTool)) {
        // `advisor_20260301` executes on Anthropic's server and has no generic
        // Chat equivalent. Remove the server-only capability rather than reject
        // the entire Claude Code request; client-executed tools remain intact.
        assertDroppableAdvisorTool(rawTool);
        droppedToolNames.add('advisor');
        continue;
      }
      assertFields(rawTool, ['name', 'description', 'input_schema', ...TOOL_HINT_FIELDS], 'tool');
      if (typeof rawTool.name !== 'string' || !rawTool.name || !isRecord(rawTool.input_schema)) unsupportedBlock('invalid tool');
      convertedTools.push({
        type: 'function',
        function: {
          name: rawTool.name,
          description: rawTool.description,
          parameters: rawTool.input_schema,
        },
      });
    }
    if (convertedTools.length) out.tools = convertedTools;
  }

  if (body.tool_choice !== undefined) {
    out.tool_choice = mapToolChoice(body.tool_choice, droppedToolNames);
  }
  return out;
}
