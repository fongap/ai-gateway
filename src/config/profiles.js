// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Provider Profile / Compatibility metadata — a static, conservative descriptor
// of how a node reaches its upstream. It is NOT a model-capability store and it
// is NOT a transport adapter.
//
// Honest scope:
//   * The generic gateway always talks the OpenAI Chat Completions wire format
//     upstream (/v1/chat/completions) for every provider, regardless of label.
//     Therefore EVERY profile reports chat_completions: 'native' and
//     responses/messages: 'convert'. No profile claims a native /v1/messages,
//     /v1/responses, or Gemini endpoint that the gateway does not actually use.
//   * `id` is a compatibility hint so /v1/models can label a backend to a human
//     operator. It makes no transport promise.
//   * Model capabilities (tools / reasoning / vision / stream) and reasoning
//     efforts belong to the Model Registry (src/config/registry.js), NOT here. A
//     provider never asserts what every model under it can do.
//
// A future Provider-specific TransportAdapter (openai-chat / anthropic /
// openai-responses / gemini) is deliberately NOT built in this release.

// `supportsStreamUsage` is a compatibility CAPABILITY, not a node id: it says
// whether a streaming request may have `stream_options: { include_usage: true }`
// added without breaking the (OpenAI-chat-wire) upstream. It defaults to true
// because the gateway talks the OpenAI Chat Completions wire format upstream,
// and mainstream OpenAI-compatible providers accept the field. An operator can
// still turn it OFF per provider via STREAM_USAGE_INCLUDE_OFF_PROVIDERS (or
// globally via STREAM_INCLUDE_USAGE=off) without editing any node id.
export const OPENAI_COMPATIBLE_PROFILE = Object.freeze({
  id: 'openai-compatible',
  transport: Object.freeze({ kind: 'openai-chat', upstream_path: '/v1/chat/completions' }),
  protocols: Object.freeze({
    chat_completions: 'native',
    responses: 'convert',
    messages: 'convert',
  }),
  supportsStreamUsage: true,
});

export const ANTHROPIC_COMPATIBLE_PROFILE = Object.freeze({
  id: 'anthropic-compatible',
  transport: Object.freeze({ kind: 'openai-chat', upstream_path: '/v1/chat/completions' }),
  protocols: Object.freeze({
    chat_completions: 'native',
    responses: 'convert',
    messages: 'convert',
  }),
  supportsStreamUsage: true,
});

export const OPENAI_RESPONSES_COMPATIBLE_PROFILE = Object.freeze({
  id: 'openai-responses-compatible',
  transport: Object.freeze({ kind: 'openai-chat', upstream_path: '/v1/chat/completions' }),
  protocols: Object.freeze({
    chat_completions: 'native',
    responses: 'convert',
    messages: 'convert',
  }),
  supportsStreamUsage: true,
});

export const GEMINI_COMPATIBLE_PROFILE = Object.freeze({
  id: 'gemini-compatible',
  transport: Object.freeze({ kind: 'openai-chat', upstream_path: '/v1/chat/completions' }),
  protocols: Object.freeze({
    chat_completions: 'native',
    responses: 'convert',
    messages: 'convert',
  }),
  supportsStreamUsage: true,
});

export const PROFILE_IDS = new Set([
  OPENAI_COMPATIBLE_PROFILE.id,
  ANTHROPIC_COMPATIBLE_PROFILE.id,
  OPENAI_RESPONSES_COMPATIBLE_PROFILE.id,
  GEMINI_COMPATIBLE_PROFILE.id,
]);

// Resolve a compatibility profile from a node's `provider` label. Unknown
// providers (and any provider that only differs by base_url/key/model) get the
// default openai-compatible profile.
export function resolveProviderProfile(provider) {
  const label = String(provider || '').trim().toLowerCase();
  if (label === 'anthropic' || label === 'anthropic-native' || label === 'claude') {
    return ANTHROPIC_COMPATIBLE_PROFILE;
  }
  if (label === 'openai' || label === 'openai-responses-native' || label === 'gpt' || label === 'o1' || label === 'o3') {
    return OPENAI_RESPONSES_COMPATIBLE_PROFILE;
  }
  if (label === 'gemini' || label === 'google' || label === 'google-gemini') {
    return GEMINI_COMPATIBLE_PROFILE;
  }
  return OPENAI_COMPATIBLE_PROFILE;
}

// Surfaces this profile can expose to gateway clients, with the honest
// native-vs-convert answer per surface. Returned as { chat_completions,
// responses, messages }.
export function exposeSurfaces(profile) {
  return {
    chat_completions: profile.protocols.chat_completions,
    responses: profile.protocols.responses,
    messages: profile.protocols.messages,
  };
}

// Decide whether a streaming outbound request should carry
// `stream_options.include_usage` for a given node. Order of precedence:
//   1. global kill switch  STREAM_INCLUDE_USAGE=off            -> never
//   2. global force switch STREAM_INCLUDE_USAGE=on             -> always
//   3. auto (default): the profile capability, minus the operator's explicit
//      per-provider off-list STREAM_USAGE_INCLUDE_OFF_PROVIDERS.
// No node id is ever consulted; this is pure capability + operator policy, so
// a provider that rejects `include_usage` can be opted out without code edits.
export function streamUsageSupported(node, env = {}) {
  const mode = String(env?.STREAM_INCLUDE_USAGE ?? '').trim().toLowerCase();
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  if (node?.profile?.supportsStreamUsage === false) return false;
  const offList = String(env?.STREAM_USAGE_INCLUDE_OFF_PROVIDERS ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const provider = String(node?.provider ?? '').trim().toLowerCase();
  return !(provider && offList.includes(provider));
}
