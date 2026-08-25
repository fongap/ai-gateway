// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Responses tool / function_call helpers, shared by the inbound (request) and
// outbound (response + stream) paths. All money-path concerns (id stability,
// argument normalization, parallel tool calls) live here so failover can never
// replay a half-converted call.

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Responses tool definition -> OpenAI Chat tool. Only `function` tools are
// representable by a generic chat-completions upstream; host-managed tools
// (web_search, file_search, computer_use, code_interpreter, custom) are NOT
// silently dropped — the caller turns them into a clear 400.
export function convertResponsesToolToChat(tool) {
  if (!isPlainObject(tool)) return { unsupported: 'tool entry is not an object' };
  if (tool.type !== 'function') return { unsupported: `tool type "${tool.type}" is not supported by chat-completions upstreams` };
  if (typeof tool.name !== 'string' || !tool.name.trim()) return { unsupported: 'function tool requires a name' };
  return {
    ok: true,
    tool: {
      type: 'function',
      function: {
        name: tool.name.trim(),
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: isPlainObject(tool.parameters) ? tool.parameters : { type: 'object', properties: {} },
        ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
      },
    },
  };
}

// Convert ALL Responses tools; returns { chatTools, unsupported[] }.
export function convertResponsesToolsToChat(tools) {
  const chatTools = [];
  const unsupported = [];
  for (const tool of tools || []) {
    const converted = convertResponsesToolToChat(tool);
    if (converted.ok) chatTools.push(converted.tool);
    else unsupported.push(converted.unsupported);
  }
  return { chatTools, unsupported };
}

export function convertResponsesToolChoice(choice) {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === 'string') {
    if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
    return undefined;
  }
  if (isPlainObject(choice)) {
    if (choice.type === 'function' && typeof choice.name === 'string' && choice.name) {
      return { type: 'function', function: { name: choice.name } };
    }
    if (choice.type === 'nullable') return 'none';
  }
  return undefined;
}

// Normalize a Responses function_call item's raw arguments into a JSON object.
export function normalizeToolArguments(value) {
  if (isPlainObject(value)) return value;
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : { _raw: parsed };
  } catch {
    return { _raw: raw };
  }
}

// Compact JSON string for a normalized arguments object (or raw string).
export function toolArgumentsToJson(value) {
  if (isPlainObject(value)) return JSON.stringify(value);
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  return raw.startsWith('{') ? raw : JSON.stringify(normalizeToolArguments(raw));
}

// Validate a fully assembled function-call arguments string. Returns the
// compact JSON string, or null when it is not a valid JSON object (the caller
// marks the call failed rather than emitting replay-unsafe output).
export function normalizedFunctionCallArguments(raw) {
  const str = String(raw ?? '').trim();
  if (!str) return '{}';
  try {
    const parsed = JSON.parse(str);
    if (!isPlainObject(parsed)) return JSON.stringify({ _raw: parsed });
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

// Build a Responses function_call output item.
export function buildFunctionCallItem({ id, callId, name, argumentsJson = '{}', status = 'completed' }) {
  return {
    id,
    type: 'function_call',
    status,
    call_id: callId,
    name,
    arguments: argumentsJson,
  };
}

// Build a Responses message output item (text).
export function buildMessageItem({ id, text, status = 'completed' }) {
  return {
    id,
    type: 'message',
    status,
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}
