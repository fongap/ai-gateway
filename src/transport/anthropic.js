// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Anthropic transport: upstream path, native headers and protocol-specific
// response semantics for every node with protocol "anthropic".
//
// Scope: request shape (path/headers/model substitution/stream detection) and
// protocol-specific response handling ONLY. Reliability belongs to
// src/scheduler and src/reliability.
//
// Surface:
//   messages -> {base_url}/v1/messages  (NATIVE — never converted to/from
//                                         OpenAI chat completions)

export const ANTHROPIC_SURFACE_PATH = Object.freeze({
  messages: '/v1/messages',
});

export function resolveAnthropicPath(surface) {
  const path = ANTHROPIC_SURFACE_PATH[surface];
  if (!path) throw new Error(`unknown Anthropic surface: ${surface}`);
  return path;
}

// Anthropic-native upstream headers. The credential is sent as `x-api-key`
// (the Anthropic auth header) — NOT "Authorization: Bearer", which is an
// OpenAI-ism. The client's own gateway key (x-api-key / Authorization) is
// never forwarded: only the node credential reaches the upstream.
//
// anthropic-version: forwarded from the client when present, otherwise the
// current stable version. anthropic-beta: forwarded verbatim when the client
// opted into a beta feature — dropping it would silently change behavior.
export function buildAnthropicHeaders(request, credential, requestId) {
  const headers = new Headers();
  headers.set('x-api-key', credential);
  const clientVersion = request.headers.get('anthropic-version');
  headers.set('anthropic-version', clientVersion || '2023-06-01');
  const clientBeta = request.headers.get('anthropic-beta');
  if (clientBeta) headers.set('anthropic-beta', clientBeta.slice(0, 512));
  headers.set('Content-Type', request.headers.get('content-type') || 'application/json');
  headers.set('Accept', request.headers.get('accept') || 'application/json');
  headers.set('User-Agent', 'ai-gateway');
  headers.set('Accept-Encoding', 'identity');
  headers.set('X-Request-ID', requestId);
  return headers;
}

// Anthropic-native first-real-output predicate for the first-event guard:
// only content_block_delta events carrying text / thinking / tool-input
// deltas are real model output. Lifecycle events (message_start,
// content_block_start, content_block_stop, ping, message_delta) are NOT
// commit points — a node that streams them before dying can still fail over.
export function isAnthropicNativeRealOutput(json) {
  if (json?.type !== 'content_block_delta') return false;
  const delta = json?.delta;
  if (delta?.type === 'text_delta') return typeof delta.text === 'string' && delta.text.trim().length > 0;
  if (delta?.type === 'thinking_delta') return typeof delta.thinking === 'string' && delta.thinking.trim().length > 0;
  if (delta?.type === 'input_json_delta') return typeof delta.partial_json === 'string' && delta.partial_json.trim().length > 0;
  return false;
}

export function isAnthropicMessageMeaningful(json) {
  for (const block of json?.content ?? []) {
    if ((block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)
      || (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim().length > 0)) return true;
    if (block?.type === 'tool_use' && typeof block.name === 'string' && block.name.trim().length > 0) return true;
  }
  return false;
}
