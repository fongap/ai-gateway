// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Transport layer — protocol-aware upstream plumbing.
//
//   Client surface -> (protocol, surface) -> Transport -> native upstream path
//
// The transport decides: upstream path, upstream headers, protocol-specific
// stream semantics and response handling. It NEVER decides scheduling,
// cooldowns, circuit state, hedges or failover budgets — those stay in
// src/scheduler / src/reliability and are protocol-agnostic.
//
// Exactly two protocol families exist:
//   openai    -> chat_completions, responses
//   anthropic -> messages

import { resolveOpenAIPath, buildOpenAIHeaders, isResponsesRealOutput, isOpenAIChatRealOutput, isOpenAIChatCompletionMeaningful, isOpenAIResponsesObjectMeaningful, OPENAI_SURFACE_PATH } from './openai.js';
import { resolveAnthropicPath, buildAnthropicHeaders, isAnthropicNativeRealOutput, isAnthropicMessageMeaningful, ANTHROPIC_SURFACE_PATH } from './anthropic.js';

export { isOpenAIStreamingResponse, withUsageStreamOptions } from '../protocol/openai.js';
export { OPENAI_SURFACE_PATH, resolveOpenAIPath, buildOpenAIHeaders, isResponsesRealOutput, isOpenAIChatRealOutput, isOpenAIChatCompletionMeaningful, isOpenAIResponsesObjectMeaningful };
export { ANTHROPIC_SURFACE_PATH, resolveAnthropicPath, buildAnthropicHeaders, isAnthropicNativeRealOutput, isAnthropicMessageMeaningful };

// The upstream path for a (protocol, surface) pair. Both must be valid: the
// config layer already validated node.protocol / node.surfaces, and the
// request handler derives the surface from the route, so an unknown pair is
// an internal invariant break — fail loudly instead of guessing a path.
export function resolveUpstreamPath(protocol, surface) {
  switch (protocol) {
    case 'openai': return resolveOpenAIPath(surface);
    case 'anthropic': return resolveAnthropicPath(surface);
    default: throw new Error(`unknown protocol: ${protocol}`);
  }
}

// Protocol-aware upstream headers. Client auth material never reaches the
// upstream for either protocol; the node credential is applied in the
// protocol's native auth header shape.
export function buildUpstreamHeadersFor(protocol, request, credential, requestId) {
  switch (protocol) {
    case 'openai': return buildOpenAIHeaders(request, credential, requestId);
    case 'anthropic': return buildAnthropicHeaders(request, credential, requestId);
    default: throw new Error(`unknown protocol: ${protocol}`);
  }
}
