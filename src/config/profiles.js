// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Provider Capability / Profile — a lightweight, static descriptor of what a
// node can speak, NOT a runtime state holder.
//
// Purpose: describe protocol differences so /v1/models and the request flow can
// report capability honestly without inventing one custom Adapter per provider.
//
// Rules of scope:
//   * Capability/Profile NEVER carries credentials, circuit state, cooldowns,
//     health, concurrency, or tier — those stay on the Runtime Node / Scheduler
//     / Reliability layers.
//   * Providers that differ only by base_url + api key + model name (NVIDIA NIM,
//     OpenRouter, Cerebras, SiliconFlow, most OpenAI-compatible APIs) share the
//     default 'openai-compatible' profile. Only genuine protocol divergence
//     (Anthropic native, OpenAI Responses native, Gemini native) gets a profile.
//   * `protocols` describes what the PROFILE is natively vs converted. The
//     gateway's generic provider always talks Chat Completions upstream, so for
//     the default profile 'responses' and 'messages' are conversions.

export const OPENAI_COMPATIBLE_PROFILE = Object.freeze({
  id: 'openai-compatible',
  protocols: Object.freeze({
    chat_completions: 'native',
    responses: 'convert',
    messages: 'convert',
  }),
  capabilities: Object.freeze({
    tools: true,
    reasoning: true,
    vision: true,
    stream: true,
  }),
  reasoning_efforts: Object.freeze(['minimal', 'low', 'medium', 'high']),
});

export const ANTHROPIC_NATIVE_PROFILE = Object.freeze({
  id: 'anthropic-native',
  protocols: Object.freeze({
    chat_completions: 'convert',
    responses: 'convert',
    messages: 'native',
  }),
  capabilities: Object.freeze({
    tools: true,
    reasoning: true,
    vision: true,
    stream: true,
  }),
  reasoning_efforts: Object.freeze(['low', 'medium', 'high']),
});

export const OPENAI_RESPONSES_NATIVE_PROFILE = Object.freeze({
  id: 'openai-responses-native',
  protocols: Object.freeze({
    chat_completions: 'convert',
    responses: 'native',
    messages: 'convert',
  }),
  capabilities: Object.freeze({
    tools: true,
    reasoning: true,
    vision: true,
    stream: true,
  }),
  reasoning_efforts: Object.freeze(['minimal', 'low', 'medium', 'high', 'none']),
});

export const GEMINI_NATIVE_PROFILE = Object.freeze({
  id: 'gemini-native',
  protocols: Object.freeze({
    chat_completions: 'convert',
    responses: 'convert',
    messages: 'convert',
  }),
  capabilities: Object.freeze({
    tools: true,
    reasoning: true,
    vision: true,
    stream: true,
  }),
  reasoning_efforts: Object.freeze(['low', 'medium', 'high']),
});

export const PROFILE_IDS = new Set([
  OPENAI_COMPATIBLE_PROFILE.id,
  ANTHROPIC_NATIVE_PROFILE.id,
  OPENAI_RESPONSES_NATIVE_PROFILE.id,
  GEMINI_NATIVE_PROFILE.id,
]);

// Resolve a static profile from a node's `provider` label. Unknown providers
// (and any provider that only differs by base_url/key/model) get the default
// openai-compatible profile.
export function resolveProviderProfile(provider) {
  const label = String(provider || '').trim().toLowerCase();
  if (label === 'anthropic' || label === 'anthropic-native' || label === 'claude') {
    return ANTHROPIC_NATIVE_PROFILE;
  }
  if (label === 'openai' || label === 'openai-responses-native' || label === 'gpt' || label === 'o1' || label === 'o3') {
    return OPENAI_RESPONSES_NATIVE_PROFILE;
  }
  if (label === 'gemini' || label === 'google' || label === 'google-gemini') {
    return GEMINI_NATIVE_PROFILE;
  }
  return OPENAI_COMPATIBLE_PROFILE;
}

// Protocols this profile can EXPOSE to gateway clients (the gateway always
// exposes all three surfaces; the value says whether the upstream is native or
// the gateway converts). Returned as ['native','convert'] per surface.
export function exposeSurfaces(profile) {
  return {
    chat_completions: profile.protocols.chat_completions,
    responses: profile.protocols.responses,
    messages: profile.protocols.messages,
  };
}
