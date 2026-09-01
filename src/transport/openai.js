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

const RESPONSES_MEANINGFUL_DELTA_TYPES = new Set([
  'response.output_text.delta',
  'response.reasoning_text.delta',
  'response.reasoning_summary_text.delta',
  'response.function_call_arguments.delta',
  'response.refusal.delta',
]);

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
  if (!RESPONSES_MEANINGFUL_DELTA_TYPES.has(type)) return false;
  return typeof json?.delta === 'string' && json.delta.trim().length > 0;
}

// OpenAI Chat meaningful-output predicate for the Tier 1 first-event guard.
// The original Chat guard committed on ANY parseable non-error event — a bare
// role-only delta ({"delta":{"role":"assistant"}}) closed the failover boundary
// and was recorded as TTFT, even though no real token had flowed. For Tier 1's
// passive TTFT learning this is only used when the node is tier-1, so Tier 2/3
// keep the original lax boundary. Real output = non-empty text, a reasoning
// increment, or a tool-call increment; role-only / empty / usage-only deltas do
// NOT commit, so a node that announces itself and then dies can still rotate.
export function isOpenAIChatRealOutput(json) {
  const choices = json?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  for (const c of choices) {
    const delta = c?.delta;
    if (!delta || typeof delta !== 'object') continue;
    if (typeof delta.content === 'string' && delta.content.trim().length > 0) return true;
    const reasoning = delta.reasoning ?? delta.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.trim().length > 0) return true;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.some(isMeaningfulToolCall)) return true;
  }
  return false;
}

function isMeaningfulToolCall(call) {
  if (!call || typeof call !== 'object') return false;
  if (typeof call.id === 'string' && call.id.trim().length > 0) return true;
  const fn = call.function;
  return Boolean(fn && (
    (typeof fn.name === 'string' && fn.name.trim().length > 0)
    || (typeof fn.arguments === 'string' && fn.arguments.trim().length > 0)
  ));
}

export function isOpenAIChatCompletionMeaningful(json) {
  for (const choice of json?.choices ?? []) {
    const message = choice?.message;
    if (!message || typeof message !== 'object') continue;
    if (typeof message.content === 'string' && message.content.trim().length > 0) return true;
    const reasoning = message.reasoning ?? message.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.trim().length > 0) return true;
    if (Array.isArray(message.tool_calls) && message.tool_calls.some(isMeaningfulToolCall)) return true;
  }
  return false;
}

export function isOpenAIResponsesObjectMeaningful(json) {
  for (const item of json?.output ?? []) {
    if (item?.type === 'function_call' && (
      (typeof item.name === 'string' && item.name.trim().length > 0)
      || (typeof item.arguments === 'string' && item.arguments.trim().length > 0)
    )) return true;
    for (const part of [...(item?.content ?? []), ...(item?.summary ?? [])]) {
      const text = part?.text ?? part?.content;
      if (typeof text === 'string' && text.trim().length > 0) return true;
    }
  }
  return false;
}
