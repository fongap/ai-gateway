// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// OpenAI transport: upstream paths, headers and protocol-specific response
// semantics for every node with protocol "openai".
//
// Scope: request shape (path/headers/model substitution/stream detection) and
// protocol-specific response handling ONLY. Reliability (scheduler, cooldowns,
// circuit breaker, hedges, failover budgets) lives in src/scheduler and
// src/reliability and is protocol-agnostic.
//
// Surfaces:
//   chat_completions -> {base_url}/v1/chat/completions
//   responses        -> {base_url}/v1/responses   (NATIVE — never converted
//                                                     to/from chat completions)

// Upstream path per surface. The gateway forwards OpenAI requests to the
// native OpenAI-compatible endpoint of the same surface.
export const OPENAI_SURFACE_PATH = Object.freeze({
  chat_completions: '/v1/chat/completions',
  responses: '/v1/responses',
});

export function resolveOpenAIPath(surface) {
  const path = OPENAI_SURFACE_PATH[surface];
  if (!path) throw new Error(`unknown OpenAI surface: ${surface}`);
  return path;
}

// Strict upstream header allowlist. Client auth material is never forwarded;
// the only Authorization header is the one built from the Runtime Node
// credential. See buildUpstreamHeadersFor (transport/index.js) for the
// protocol dispatch.
export function buildOpenAIHeaders(request, credential, requestId) {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${credential}`);
  headers.set('Content-Type', request.headers.get('content-type') || 'application/json');
  headers.set('Accept', request.headers.get('accept') || 'application/json');
  headers.set('User-Agent', 'ai-gateway');
  headers.set('Accept-Encoding', 'identity');
  headers.set('X-Request-ID', requestId);
  const idempotencyKey = request.headers.get('idempotency-key');
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey.slice(0, 256));
  return headers;
}

// OpenAI Responses first-real-output predicate for the first-event guard:
// a `response.*.delta` event carries model output; lifecycle events
// (response.created / output_item.added / …) do NOT commit the failover
// boundary, so a node that announces itself and then dies can still be
// rotated away from.
export function isResponsesRealOutput(json) {
  const type = json?.type;
  return typeof type === 'string' && type.startsWith('response.') && type.endsWith('.delta');
}
