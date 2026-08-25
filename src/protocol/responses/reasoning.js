// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Reasoning / thinking preservation across the Responses <-> Chat boundary.
//
// Rationale: never demote a Reasoning item into plain text and never drop an
// upstream reasoning trace silently. Where a generic chat-completions
// upstream natively supports `reasoning_effort`, prefer native passthrough;
// where it does not, apply the smallest necessary conversion; where the target
// protocol cannot represent the value losslessly, degrade explicitly rather
// than pretending full compatibility.

import { isPlainObject } from './tools.js';

export function extractReasoningText(source) {
  if (typeof source === 'string') return source;
  if (Array.isArray(source)) {
    const text = source.map((x) => x?.text || x?.content || '').filter(Boolean).join('');
    return text || '';
  }
  return '';
}

// A Responses reasoning output item. `summary` mirrors the model-generated
// summary facet; `content` carries the raw reasoning text when it was exposed.
// When `encrypted_content` is present the reasoning is opaque/redacted and is
// NEVER flattened into reasoning_text — it is preserved verbatim instead.
export function buildReasoningItem({ id, text, summary = '', status = 'completed', encrypted_content = '' }) {
  const summaryParts = summary ? [{ type: 'summary_text', text: summary }] : [];
  if (encrypted_content) {
    return { id, type: 'reasoning', status, summary: summaryParts, encrypted_content };
  }
  return {
    id,
    type: 'reasoning',
    status,
    summary: summaryParts,
    content: text ? [{ type: 'reasoning_text', text }] : [],
  };
}

// Extract a model-generated summary facet, if the upstream exposed one.
export function extractReasoningSummary(source) {
  if (!source || typeof source !== 'object') return '';
  for (const key of ['reasoning_summary', 'summary', 'reasoningSummary']) {
    const value = source[key];
    if (typeof value === 'string' && value) return value;
    if (Array.isArray(value)) {
      const text = value.map((x) => x?.text || x?.summary_text || '').filter(Boolean).join('');
      if (text) return text;
    }
  }
  if (Array.isArray(source.reasoning)) {
    for (const item of source.reasoning) {
      if (typeof item !== 'object') continue;
      const parts = Array.isArray(item.summary) ? item.summary : [];
      const text = parts.map((p) => p?.text || p?.summary_text || '').filter(Boolean).join('');
      if (text) return text;
    }
  }
  return '';
}

// Extract opaque / encrypted reasoning, if any. Never interpreted, never
// flattened — relayed verbatim so the client sees the exact opaque payload.
export function extractEncryptedReasoning(source) {
  if (!source || typeof source !== 'object') return '';
  for (const key of ['reasoning_encrypted_content', 'encrypted_reasoning', 'encrypted_content']) {
    const value = source[key];
    if (typeof value === 'string' && value) return value;
  }
  if (Array.isArray(source.reasoning)) {
    for (const item of source.reasoning) {
      if (typeof item !== 'object') continue;
      if (typeof item.encrypted_content === 'string' && item.encrypted_content) return item.encrypted_content;
    }
  }
  return '';
}

// Chat usage -> Responses usage (drop nothing, map by field name).
export function mapChatUsageToResponses(usage = {}) {
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const totalTokens = Number(usage.total_tokens ?? 0) || (inputTokens + outputTokens);
  const out = {
    input_tokens: inputTokens,
    input_tokens_details: usage.prompt_tokens_details ? { ...usage.prompt_tokens_details } : undefined,
    output_tokens: outputTokens,
    output_tokens_details: usage.completion_tokens_details ? { ...usage.completion_tokens_details } : undefined,
    total_tokens: totalTokens,
  };
  const clean = {};
  for (const [key, value] of Object.entries(out)) {
    if (value !== undefined) clean[key] = key === 'input_tokens_details' || key === 'output_tokens_details'
      ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))
      : value;
  }
  return clean;
}

// Apply a Responses `reasoning` request to a chat-completions outbound body.
// No field is added when the client does not ask for reasoning; `effort: none`
// is a no-op (chat-completions is opt-in for reasoning).
export function applyResponsesReasoning(out, body, env) {
  const reasoning = body?.reasoning;
  if (!isPlainObject(reasoning)) return;
  const effort = normalizeEffort(reasoning.effort);
  if (!effort) return; // none / unset -> default
  const mode = String(env?.RESPONSES_REASONING_MODE || 'reasoning_effort').toLowerCase();
  if (mode === 'chat_template_kwargs') {
    out.chat_template_kwargs = {
      ...(isPlainObject(out.chat_template_kwargs) ? out.chat_template_kwargs : {}),
      enable_thinking: true,
    };
    return;
  }
  if (mode === 'thinking') {
    out.thinking = { type: 'enabled', budget_tokens: Number(reasoning.budget_tokens || reasoning.max_thinking_tokens || 1024) };
    return;
  }
  out.reasoning_effort = effort;
}

function normalizeEffort(value) {
  const v = String(value ?? '').toLowerCase();
  if (!v || v === 'none' || v === 'off') return null;
  if (['low', 'medium', 'high'].includes(v)) return v;
  if (v === 'minimal') return 'low';
  if (v === 'max') return 'high';
  return 'medium';
}
