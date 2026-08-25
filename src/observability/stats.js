// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Gateway-level counters and the client-facing stream accounting wrapper.
// All state is isolate-local best-effort.

import { trackStreamResponse } from '../stream/track.js';
import { isOpenAIStreamingResponse } from '../protocol/openai.js';

export const gatewayStats = {
  startedAt: Date.now(),
  requests: 0,
  successes: 0,
  failures: 0,
  activeRequests: 0,
  cancellations: 0,
};

const COUNTED_ROUTES = new Set([
  'POST /v1/chat/completions',
  'POST /chat/completions',
  'POST /v1/messages',
  'POST /messages',
  'POST /v1/messages/count_tokens',
  'POST /messages/count_tokens',
  'POST /v1/responses',
  'POST /responses',
  'GET /v1/models',
  'GET /models',
]);

export function isCountedRoute(method, pathname) {
  return COUNTED_ROUTES.has(`${method} ${pathname}`);
}

// Wrap a response so its completion updates the client counters, including
// streaming responses that finish after the handler has returned.
export function trackClientResponse(response) {
  const ok = response.status < 400;
  const streaming = ok && isOpenAIStreamingResponse(response) && response.body;
  if (!streaming) {
    gatewayStats.activeRequests = Math.max(0, gatewayStats.activeRequests - 1);
    if (ok) gatewayStats.successes++;
    else gatewayStats.failures++;
    return response;
  }
  return trackStreamResponse(response, {
    idleTimeoutMs: 0,
    onSuccess: () => {
      gatewayStats.activeRequests = Math.max(0, gatewayStats.activeRequests - 1);
      gatewayStats.successes++;
    },
    onFailure: () => {
      gatewayStats.activeRequests = Math.max(0, gatewayStats.activeRequests - 1);
      gatewayStats.failures++;
    },
    onNeutral: () => {
      gatewayStats.activeRequests = Math.max(0, gatewayStats.activeRequests - 1);
      gatewayStats.cancellations++;
    },
  });
}
