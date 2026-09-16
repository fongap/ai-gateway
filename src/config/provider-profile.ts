// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Provider wire profiles are structural gateway knowledge, not per-account
// configuration. A household/small-team gateway should not repeat the same
// protocol/surface declaration for every API key belonging to one provider.
//
// Current contract:
//   anthropic -> Anthropic Messages
//   openai    -> OpenAI Chat Completions + Responses
//   everything else -> OpenAI-compatible Chat Completions
//
// Adding a provider-specific wire contract belongs here. Node JSON remains
// account-level data only: id, provider, base_url, models, optional priority.

import type { Protocol, Surface } from '../types/protocol.ts';

export type ProviderWireProfile = Readonly<{
  protocol: Protocol,
  surfaces: ReadonlyArray<Surface>,
}>;

const OPENAI_CHAT: ProviderWireProfile = Object.freeze({
  protocol: 'openai',
  surfaces: Object.freeze(['chat_completions'] as Surface[]),
});

const OPENAI_NATIVE: ProviderWireProfile = Object.freeze({
  protocol: 'openai',
  surfaces: Object.freeze(['chat_completions', 'responses'] as Surface[]),
});

const ANTHROPIC_NATIVE: ProviderWireProfile = Object.freeze({
  protocol: 'anthropic',
  surfaces: Object.freeze(['messages'] as Surface[]),
});

export function providerWireProfile(provider: string): ProviderWireProfile {
  const key = String(provider || '').trim().toLowerCase();
  if (key === 'anthropic') return ANTHROPIC_NATIVE;
  if (key === 'openai') return OPENAI_NATIVE;
  return OPENAI_CHAT;
}
