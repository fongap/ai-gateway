// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// OpenAI Responses REQUEST -> Anthropic Messages REQUEST converter
// (R0.6 / Codex path).
//
// This is an INDEPENDENT request converter. It does NOT import or reuse the
// existing reverse-direction Chat request converter
// (openai-chat-request-to-anthropic.ts). Responses and Chat have distinct
// input shapes (input[] / input_text / function_call / function_call_output
// / instructions) and must be parsed separately.
//
// Scope is intentionally limited to the subset Codex actually uses. Fields
// that cannot be losslessly represented on the Anthropic side are rejected
// with ConversionError("conversion_not_supported: ...") so the caller can
// return a clear 400 in the CLIENT (Responses) error envelope. We do NOT
// silently drop fields.
//
// Supported subset (R0.6):
//   - input as string (treated as a single user text message)
//   - input as array of items:
//       { type: "message", role: "user" | "assistant", content: [{type:"input_text"}] }
//       { type: "function_call", call_id, name, arguments }
//       { type: "function_call_output", call_id, output }
//   - instructions -> Anthropic system
//   - tools: tools[].parameters -> tools[].input_schema
//   - tool_choice: "auto" | "required" | "none" | { type: "function", name }
//   - temperature, top_p, stream, stop (string | string[])
//   - max_output_tokens -> max_tokens (single default policy when omitted)
//
// Out of scope (R0.6): reasoning items, image inputs, audio inputs,
// server-side tools, web search, file_search, mcp_servers, parallel_tool_calls,
// custom headers, store, metadata, logprobs, prompt_cache_key, etc.

import { ConversionError } from './anthropic-to-openai.ts';
import { assertFields, assertSampling, parseToolArguments } from './validation.ts';

export { ConversionError };

// Single default policy for max_tokens. Same default as the Chat reverse
// direction; the value is shared via the named export so the R6 semantic
// contract can pin it in one place.
export const DEFAULT_MAX_TOKENS = 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Extract plain text from a Responses input_text / output_text / input_image
// content part. Image/audio parts have no Anthropic lossless equivalent here
// and are rejected so the caller surfaces a conversion_not_supported error.
function extractTextFromContentPart(part: unknown): string {
  if (typeof part === 'string') return part;
  if (!isRecord(part)) {
    throw new ConversionError('conversion_not_supported: input content part is not an object');
  }
  if (part.type === 'input_text' || part.type === 'output_text') {
    return typeof part.text === 'string' ? part.text : '';
  }
  throw new ConversionError(`conversion_not_supported: input content type "${String(part.type)}" cannot be losslessly represented on Anthropic`);
}

function convertUserContent(content: unknown): string | Array<Record<string, unknown>> {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    throw new ConversionError('conversion_not_supported: user content must be a string or array of parts');
  }
  if (content.length === 0) return '';
  if (content.length === 1) {
    const single = content[0];
    if (isRecord(single) && (single.type === 'input_text' || single.type === 'output_text')) {
      return extractTextFromContentPart(single);
    }
  }
  return content.map((p) => ({ type: 'text', text: extractTextFromContentPart(p) }));
}

function convertAssistantItem(item: Record<string, unknown>): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (typeof item.content === 'string') {
    content.push({ type: 'text', text: item.content });
  } else if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (isRecord(part) && (part.type === 'output_text' || part.type === 'input_text')) {
        content.push({ type: 'text', text: typeof part.text === 'string' ? part.text : '' });
      } else {
        throw new ConversionError(`conversion_not_supported: assistant content part type "${String(isRecord(part) ? part.type : undefined)}" is not supported`);
      }
    }
  }
  return { role: 'assistant', content };
}

function convertFunctionCallItem(item: Record<string, unknown>): Record<string, unknown> {
  const callId = typeof item.call_id === 'string' ? item.call_id : '';
  const name = typeof item.name === 'string' ? item.name : '';
  if (!callId) throw new ConversionError('conversion_not_supported: function_call.call_id is required');
  if (!name) throw new ConversionError('conversion_not_supported: function_call.name is required');
  const input = parseToolArguments(item.arguments);
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: callId, name, input }],
  };
}

function convertFunctionCallOutputItem(item: Record<string, unknown>): Record<string, unknown> {
  const callId = typeof item.call_id === 'string' ? item.call_id : '';
  if (!callId) throw new ConversionError('conversion_not_supported: function_call_output.call_id is required');
  // Anthropic tool_result content must be a string. Responses allows string
  // or array of output parts; for safety, JSON-encode anything that is not
  // already a string and surface the structure as a single string.
  let content: string;
  if (typeof item.output === 'string') content = item.output;
  else if (item.output === undefined || item.output === null) content = '';
  else if (Array.isArray(item.output)) content = item.output.map(extractTextFromContentPart).join('\n');
  else throw new ConversionError('conversion_not_supported: tool output must be text');
  const result: Record<string, unknown> = {
    type: 'tool_result',
    tool_use_id: callId,
    content,
  };
  // Responses marks failed tool executions via status; surface to Anthropic
  // as is_error so the model can branch on it.
  if (typeof item.status === 'string' && item.status !== 'completed') result.is_error = true;
  return result;
}

function mapToolChoice(toolChoice: unknown): Record<string, unknown> | string | undefined {
  if (toolChoice === undefined || toolChoice === null) return undefined;
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto' || toolChoice === 'none') return { type: toolChoice };
    if (toolChoice === 'required') return { type: 'any' };
    throw new ConversionError(`conversion_not_supported: tool_choice string "${toolChoice}" is not supported`);
  }
  if (isRecord(toolChoice)) {
    assertFields(toolChoice, ['type', 'name', 'function'], 'tool_choice');
    if (toolChoice.type === 'auto' || toolChoice.type === 'none' || toolChoice.type === 'any') return { type: toolChoice.type };
    if (toolChoice.type === 'function') {
      // Responses uses { type: "function", name: "..." } to pin a single tool.
      const fn = isRecord(toolChoice.function) ? toolChoice.function : null;
      const name = (fn && typeof fn.name === 'string') ? fn.name : (typeof toolChoice.name === 'string' ? toolChoice.name : '');
      if (!name) throw new ConversionError('conversion_not_supported: tool_choice.function.name is required');
      return { type: 'tool', name };
    }
    if (toolChoice.type === 'tool') {
      if (typeof toolChoice.name !== 'string' || !toolChoice.name) {
        throw new ConversionError('conversion_not_supported: tool_choice.tool.name is required');
      }
      return { type: 'tool', name: toolChoice.name };
    }
  }
  throw new ConversionError('conversion_not_supported: tool_choice shape is not supported');
}

// Convert an OpenAI Responses request body to an Anthropic Messages request
// body. Rejects inputs that cannot be losslessly represented.
export function convertResponsesRequestToAnthropic(body: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new ConversionError('conversion_not_supported: request body is not an object');
  }
  assertFields(body, ['model', 'input', 'instructions', 'system', 'tools', 'tool_choice', 'temperature', 'top_p', 'max_tokens', 'max_output_tokens', 'stop', 'stream'], 'request');
  assertSampling(body);
  const out: Record<string, unknown> = {};

  if (body.model !== undefined) out.model = body.model;
  if (!out.model || typeof out.model !== 'string' || !out.model.trim()) {
    throw new ConversionError('conversion_not_supported: model is required');
  }

  // max_tokens / max_output_tokens: single default policy when omitted.
  const maxTokensRaw = body.max_tokens ?? body.max_output_tokens;
  if (maxTokensRaw !== undefined) {
    const mt = maxTokensRaw;
    if (typeof mt !== 'number' || !Number.isInteger(mt) || mt <= 0) {
      throw new ConversionError('conversion_not_supported: max_tokens must be a positive integer');
    }
    out.max_tokens = mt;
  } else {
    out.max_tokens = DEFAULT_MAX_TOKENS;
  }

  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stream !== undefined) out.stream = body.stream;

  if (body.stop !== undefined) {
    if (typeof body.stop === 'string') out.stop_sequences = [body.stop];
    else if (Array.isArray(body.stop) && body.stop.every((s) => typeof s === 'string')) {
      out.stop_sequences = body.stop;
    } else {
      throw new ConversionError('conversion_not_supported: stop must be a string or string[]');
    }
  }

  // Tools: Responses uses tools[].parameters (flat). Anthropic uses
  // tools[].input_schema. The R0.6 contract is the same as the Chat
  // reverse path: map parameters -> input_schema.
  if (Array.isArray(body.tools)) {
    const tools: Array<Record<string, unknown>> = [];
    for (const tool of body.tools) {
      if (!isRecord(tool)) throw new ConversionError('conversion_not_supported: tools entry is not an object');
      if (tool.type !== 'function') {
        throw new ConversionError('conversion_not_supported: only function tools are supported');
      }
      const name = typeof tool.name === 'string' ? tool.name : '';
      if (!name) throw new ConversionError('conversion_not_supported: tool.name is required');
      const desc = typeof tool.description === 'string' ? tool.description : undefined;
      assertFields(tool, ['type', 'name', 'description', 'parameters'], 'tool');
      const params = isRecord(tool.parameters) ? tool.parameters : {};
      if (params.type !== undefined && params.type !== 'object') throw new ConversionError('conversion_not_supported: tool schema must describe an object');
      const anthropicTool: Record<string, unknown> = { name };
      if (desc !== undefined) anthropicTool.description = desc;
      anthropicTool.input_schema = { ...params, type: 'object' };
      tools.push(anthropicTool);
    }
    out.tools = tools;
  }

  if (body.tool_choice !== undefined) {
    const mapped = mapToolChoice(body.tool_choice);
    if (mapped !== undefined) out.tool_choice = mapped;
  }

  // system / instructions: Responses uses `instructions` (string).
  const systemParts: string[] = [];
  if (typeof body.instructions === 'string' && body.instructions) {
    systemParts.push(body.instructions);
  }
  if (typeof body.system === 'string' && body.system) {
    systemParts.push(body.system);
  }

  // input: string OR array of items.
  if (body.input === undefined || body.input === null) {
    throw new ConversionError('conversion_not_supported: input is required');
  }

  const messages: Array<Record<string, unknown>> = [];
  const pendingToolResults: Array<Record<string, unknown>> = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    messages.push({ role: 'user', content: [...pendingToolResults] });
    pendingToolResults.length = 0;
  };

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const raw of body.input) {
      if (!isRecord(raw)) {
        throw new ConversionError('conversion_not_supported: input item is not an object');
      }
      const type = raw.type ?? (typeof raw.role === 'string' ? 'message' : undefined);
      assertFields(raw, type === 'message' ? ['type', 'role', 'content'] : type === 'function_call' ? ['type', 'call_id', 'name', 'arguments', 'id', 'status'] : ['type', 'call_id', 'output', 'id', 'status'], 'input item');
      if (type === 'message') {
        const role = raw.role;
        if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'developer') {
          throw new ConversionError(`conversion_not_supported: input message role "${String(role)}" is not supported`);
        }
        if (role === 'system' || role === 'developer') {
          // Anthropic doesn't accept system/developer message roles; fold
          // text content into the top-level system field.
          if (typeof raw.content === 'string' && raw.content) {
            systemParts.push(raw.content);
          } else if (Array.isArray(raw.content)) {
            for (const part of raw.content) {
              if (isRecord(part) && (part.type === 'input_text' || part.type === 'output_text')
                && typeof part.text === 'string' && part.text) {
                assertFields(part, ['type', 'text'], 'system content');
                systemParts.push(part.text);
              } else throw new ConversionError('conversion_not_supported: system content must be text');
            }
          }
          continue;
        }
        flushToolResults();
        if (role === 'user') {
          messages.push({ role: 'user', content: convertUserContent(raw.content) });
        } else {
          messages.push(convertAssistantItem(raw));
        }
        continue;
      }
      if (type === 'function_call') {
        flushToolResults();
        messages.push(convertFunctionCallItem(raw));
        continue;
      }
      if (type === 'function_call_output') {
        // Accumulate consecutive function_call_output items into one user
        // message containing tool_result blocks.
        pendingToolResults.push(convertFunctionCallOutputItem(raw));
        continue;
      }
      if (type === 'reasoning' || type === 'item_reference' || type === 'web_search_call' || type === 'file_search_call' || type === 'computer_call' || type === 'mcp_call' || type === 'mcp_approval_request' || type === 'image_generation_call' || type === 'code_interpreter_call') {
        throw new ConversionError(`conversion_not_supported: input item type "${type}" is not supported on Anthropic`);
      }
      throw new ConversionError(`conversion_not_supported: input item type "${String(type)}" is not supported`);
    }
    flushToolResults();
  } else {
    throw new ConversionError('conversion_not_supported: input must be a string or an array of items');
  }

  if (systemParts.length === 1) out.system = systemParts[0];
  else if (systemParts.length > 1) {
    out.system = systemParts.map((s) => ({ type: 'text', text: s }));
  }

  if (messages.length === 0) {
    throw new ConversionError('conversion_not_supported: input produced no messages');
  }
  out.messages = messages;

  return out;
}
