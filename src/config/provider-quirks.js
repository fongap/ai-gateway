// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Provider quirks — known compatibility DIFFERENCES between providers that
// speak the same protocol. This module deliberately does NOT decide anything
// structural:
//   * it never picks the protocol (node.protocol does),
//   * it never picks the upstream path (node.protocol + surface do),
//   * it never asserts model capabilities (Model Registry does).
// It only answers narrow wire-format questions like "may this OpenAI-chat
// upstream receive stream_options.include_usage without breaking?".

// Decide whether a streaming outbound request should carry
// `stream_options.include_usage` for a given node. Order of precedence:
//   1. global kill switch  STREAM_INCLUDE_USAGE=off            -> never
//   2. global force switch STREAM_INCLUDE_USAGE=on             -> always
//   3. auto (default): the node must speak the OpenAI protocol on the
//      chat_completions surface (stream_options does not exist on
//      /v1/responses or /v1/messages), minus the operator's explicit
//      per-provider off-list STREAM_USAGE_INCLUDE_OFF_PROVIDERS.
// A provider that rejects `include_usage` can be opted out without code edits.
export function streamUsageSupported(node, env = {}) {
  const mode = String(env?.STREAM_INCLUDE_USAGE ?? '').trim().toLowerCase();
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  // Structural gate: the field only exists on the OpenAI chat_completions
  // wire format. Anthropic nodes and non-chat OpenAI surfaces never get it.
  const protocol = String(node?.protocol ?? 'openai').trim().toLowerCase();
  if (protocol !== 'openai') return false;
  if (Array.isArray(node?.surfaces) && node.surfaces.length > 0
    && !node.surfaces.includes('chat_completions')) return false;
  const offList = String(env?.STREAM_USAGE_INCLUDE_OFF_PROVIDERS ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const provider = String(node?.provider ?? '').trim().toLowerCase();
  return !(provider && offList.includes(provider));
}
