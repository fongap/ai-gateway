// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Internal response-lifecycle handoff between stream synthesis and the outer
// request boundary. The marker never belongs on a client-visible response:
// trackClientResponse consumes and strips it before returning the response.

export const SYNTHETIC_CLIENT_STREAM_HEADER = 'x-gateway-internal-synthetic-stream';

export function markSyntheticClientStreamHeaders(headers?: Record<string, string>): Record<string, string> {
  return {
    ...(headers || {}),
    [SYNTHETIC_CLIENT_STREAM_HEADER]: '1',
  };
}
