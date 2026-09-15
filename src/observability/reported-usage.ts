// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Tiny protocol-neutral helpers for locating an upstream-reported usage object.
// They do NOT normalize or estimate token counts. The only supported shapes are
// the native wire locations already consumed elsewhere in the gateway.

export function reportedUsageFromPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const data = payload as Record<string, any>;
  if (data.response && typeof data.response === 'object' && data.response.usage !== undefined) {
    return data.response.usage;
  }
  if (data.message && typeof data.message === 'object' && data.message.usage !== undefined) {
    return data.message.usage;
  }
  if (data.usage !== undefined) return data.usage;
  return null;
}

export function reportedUsageFromJsonText(text: unknown): unknown {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    return reportedUsageFromPayload(JSON.parse(text));
  } catch {
    return null;
  }
}
