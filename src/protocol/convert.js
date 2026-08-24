// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Protocol conversion between Anthropic Messages and OpenAI Chat Completions.
// Non-streaming conversions only; streaming lives in src/stream/.

import { extractOpenAITextContent } from './openai.js';

export function anthropicToOpenAIRequest(body, upstreamModel, env) {
  const messages = [];
  const systemContent = convertAnthropicSystem(body.system);
  if (systemContent) messages.push({ role: 'system', content: systemContent });
  for (const message of body.messages || []) {
    for (const item of convertAnthropicMessageToOpenAI(message)) messages.push(item);
  }

  const fakeStream = String(env?.FAKE_STREAM_PROTECTION ?? '').trim().toLowerCase() === 'true';
  const stream = body.stream === true || fakeStream;

  const out = {
    model: upstreamModel,
    messages,
    stream,
    max_tokens: Number(body.max_tokens),
  };

  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (typeof body.top_k === 'number') out.top_k = body.top_k;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (body.metadata?.user_id) out.user = String(body.metadata.user_id);

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map(convertAnthropicToolToOpenAI).filter(Boolean);
    if (body.tool_choice) {
      const tc = convertAnthropicToolChoiceToOpenAI(body.tool_choice);
      if (tc !== undefined) out.tool_choice = tc;
      if (typeof body.tool_choice.disable_parallel_tool_use === 'boolean') {
        out.parallel_tool_calls = !body.tool_choice.disable_parallel_tool_use;
      }
    }
  }

  applyReasoningRequest(out, body, env);
  return out;
}

function convertAnthropicSystem(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  const parts = [];
  for (const block of system) {
    if (typeof block === 'string') parts.push(block);
    else if (block?.type === 'text') parts.push(block.text || '');
    else if (block) parts.push(`[Unsupported system block ${block.type || 'unknown'} omitted]`);
  }
  return parts.filter(Boolean).join('\n\n');
}

function convertAnthropicMessageToOpenAI(message) {
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return [];
  if (typeof message.content === 'string') return [{ role: message.role, content: message.content }];
  const blocks = Array.isArray(message.content) ? message.content : [];
  return message.role === 'assistant'
    ? [convertAssistantBlocks(blocks)]
    : convertUserBlocks(blocks);
}

function convertAssistantBlocks(blocks) {
  const textParts = [];
  const reasoningParts = [];
  const toolCalls = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') textParts.push(block.text || '');
    else if (block.type === 'thinking') reasoningParts.push(block.thinking || '');
    else if (block.type === 'redacted_thinking') reasoningParts.push('[redacted thinking]');
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || `call_${randomId()}`,
        type: 'function',
        function: {
          name: block.name || 'unknown_tool',
          arguments: JSON.stringify(isPlainObject(block.input) ? block.input : {}),
        },
      });
    }
  }
  const out = { role: 'assistant', content: textParts.length ? textParts.join('') : null };
  if (toolCalls.length) out.tool_calls = toolCalls;
  if (reasoningParts.length) out.reasoning_content = reasoningParts.join('\n\n');
  return out;
}

function convertUserBlocks(blocks) {
  const results = [];
  const userParts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool_result') {
      results.push({
        role: 'tool',
        tool_call_id: block.tool_use_id || '',
        content: convertToolResultContentToString(block.content, block.is_error === true),
      });
      continue;
    }
    const converted = convertContentBlock(block);
    if (converted !== null) userParts.push(converted);
  }
  if (userParts.length) {
    const onlyText = userParts.every((part) => part?.type === 'text');
    results.push({
      role: 'user',
      content: onlyText ? userParts.map((p) => p.text || '').join('') : userParts,
    });
  } else if (!results.length) {
    results.push({ role: 'user', content: '' });
  }
  return results;
}

function convertContentBlock(block) {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text || '' };
    case 'image': {
      const url = sourceToDataUrl(block.source);
      return url
        ? { type: 'image_url', image_url: { url } }
        : { type: 'text', text: '[Unsupported image source omitted]' };
    }
    case 'document':
      return { type: 'text', text: documentToText(block) };
    default:
      return { type: 'text', text: `[Unsupported Anthropic content block ${block.type || 'unknown'} omitted]` };
  }
}

function sourceToDataUrl(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'base64' && source.data) {
    return `data:${source.media_type || 'application/octet-stream'};base64,${source.data}`;
  }
  if (source.type === 'url' && source.url) return String(source.url);
  return null;
}

function documentToText(block) {
  const source = block?.source || {};
  if (source.type === 'text') return String(source.data || source.text || '');
  if (source.type === 'url') return `[Document URL: ${source.url || ''}]`;
  if (source.type === 'base64' && String(source.media_type || '').startsWith('text/') && source.data) {
    try { return decodeBase64Utf8(source.data); } catch { /* fall through */ }
  }
  return '[Unsupported document omitted]';
}

function decodeBase64Utf8(data) {
  const binary = atob(String(data || ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function convertToolResultContentToString(content, isError) {
  const prefix = isError ? '[Tool execution error]\n' : '';
  if (content === undefined || content === null) return prefix;
  if (typeof content === 'string') return prefix + content;
  if (!Array.isArray(content)) return prefix + JSON.stringify(content);
  const parts = content.map((block) => {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return String(block ?? '');
    if (block.type === 'text') return block.text || '';
    if (block.type === 'image') return '[Tool-result image omitted]';
    if (block.type === 'document') return documentToText(block);
    return JSON.stringify(block);
  });
  return prefix + parts.filter(Boolean).join('\n');
}

function convertAnthropicToolToOpenAI(tool) {
  if (!tool || typeof tool !== 'object' || !tool.name) return null;
  return {
    type: 'function',
    function: {
      name: String(tool.name),
      description: String(tool.description || ''),
      parameters: isPlainObject(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} },
    },
  };
}

function convertAnthropicToolChoiceToOpenAI(choice) {
  if (!choice || typeof choice !== 'object') return undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool' && choice.name) return { type: 'function', function: { name: choice.name } };
  return 'auto';
}

function applyReasoningRequest(out, body, env) {
  const mode = String(env?.ANTHROPIC_REASONING_REQUEST_MODE || 'none').toLowerCase();
  const thinking = body.thinking;
  const effort = body.output_config?.effort || inferEffortFromThinking(thinking);
  const thinkingEnabled = thinking?.type === 'enabled' || thinking?.type === 'adaptive';
  if (!thinkingEnabled && !effort) return;
  if (mode === 'reasoning_effort') {
    out.reasoning_effort = normalizeEffort(effort || 'medium');
  } else if (mode === 'chat_template_kwargs') {
    out.chat_template_kwargs = {
      ...(isPlainObject(out.chat_template_kwargs) ? out.chat_template_kwargs : {}),
      enable_thinking: true,
    };
  } else if (mode === 'thinking') {
    out.thinking = thinking?.type === 'enabled'
      ? { type: 'enabled', budget_tokens: Number(thinking.budget_tokens || 1024) }
      : { type: 'adaptive' };
  }
}

function inferEffortFromThinking(thinking) {
  if (!thinking || thinking.type === 'disabled') return null;
  if (thinking.type === 'adaptive') return 'medium';
  const budget = Number(thinking.budget_tokens || 0);
  if (budget >= 16000) return 'high';
  if (budget >= 4096) return 'medium';
  return 'low';
}

function normalizeEffort(value) {
  const v = String(value || 'medium').toLowerCase();
  if (['low', 'medium', 'high'].includes(v)) return v;
  if (v === 'max') return 'high';
  if (v === 'minimal') return 'low';
  return 'medium';
}

// ---- OpenAI response -> Anthropic message ---------------------------------

export function openAIToAnthropicMessage(data, requestedModel) {
  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  const reasoning = extractOpenAIReasoning(message, choice);
  if (reasoning) {
    content.push({ type: 'thinking', thinking: reasoning, signature: gatewayThinkingSignature(requestedModel) });
  }
  const text = extractTextContent(message.content);
  if (text) content.push({ type: 'text', text });
  if (message.refusal) content.push({ type: 'text', text: String(message.refusal) });

  const toolCalls = Array.isArray(message.tool_calls) ? [...message.tool_calls] : [];
  if (message.function_call) {
    toolCalls.push({
      id: `call_${randomId()}`,
      type: 'function',
      function: message.function_call,
    });
  }
  for (const call of toolCalls) {
    content.push({
      type: 'tool_use',
      id: call.id || `toolu_${randomId()}`,
      name: call?.function?.name || 'unknown_tool',
      input: parseToolArgumentsObject(call?.function?.arguments),
    });
  }
  if (content.length === 0) {
    throw new Error('Upstream returned an empty response without text, reasoning, or tool calls.');
  }
  return {
    id: normalizeAnthropicMessageId(data?.id),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: mapFinishReason(choice.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    usage: mapUsageToAnthropic(data?.usage || {}),
  };
}

function extractTextContent(content) {
  return extractOpenAITextContent(content);
}

function extractOpenAIReasoning(message, choice) {
  const candidates = [message?.reasoning_content, message?.reasoning, choice?.reasoning_content, choice?.reasoning];
  for (const value of candidates) {
    if (typeof value === 'string' && value) return value;
    if (Array.isArray(value)) {
      const text = value.map((x) => x?.text || x?.content || '').filter(Boolean).join('');
      if (text) return text;
    }
  }
  return '';
}

export function mapUsageToAnthropic(usage) {
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0) || 0;
  const thinkingTokens = Number(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.thinking_tokens ?? 0) || 0;
  const result = { input_tokens: inputTokens, output_tokens: outputTokens };
  if (cached > 0) result.cache_read_input_tokens = cached;
  if (thinkingTokens > 0) result.output_tokens_details = { thinking_tokens: thinkingTokens };
  return result;
}

export function mapFinishReason(reason, hasTools = false) {
  if (hasTools || reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter' || reason === 'refusal') return 'refusal';
  return 'end_turn';
}

export function normalizeAnthropicMessageId(id) {
  const raw = String(id || '');
  if (raw.startsWith('msg_')) return raw;
  return `msg_${raw.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40) || randomId()}`;
}

export function gatewayThinkingSignature(model) {
  let hash = 5381;
  const str = String(model || 'model');
  for (let i = 0; i < str.length; i++) hash = ((hash * 33) ^ str.charCodeAt(i)) >>> 0;
  return `gateway_unsigned_${hash.toString(16)}`;
}

function parseToolArgumentsObject(value) {
  if (isPlainObject(value)) return value;
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  try {
    const parsed = JSON.parse(raw || '{}');
    return isPlainObject(parsed) ? parsed : { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

export function normalizeToolArgumentsJson(value) {
  return JSON.stringify(parseToolArgumentsObject(value));
}

export function randomId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
