// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Gateway request counters and the client-facing stream accounting wrapper.
// All state is isolate-local best-effort.

import { isOpenAIStreamingResponse } from '../protocol/openai.ts';

export const gatewayStats = {
  startedAt: Date.now(),
  requests: 0,
  successes: 0,
  failures: 0,
  activeRequests: 0,
  cancellations: 0,
};

// Node-layer stream lifecycle counters (gateway_stream_* in /metrics).
// Emitted only by the node-layer tracking in handler.ts: the client-facing
// trackClientResponse wrapper below passes no telemetry callbacks, so each
// stream is counted exactly once. Invariant:
// interrupted === missingCompletion + idleTimeout + readerError.
export const streamStats: Record<string, number> = {
  started: 0,
  completed: 0,
  interrupted: 0,
  missingCompletion: 0,
  idleTimeout: 0,
  readerError: 0,
};

export function recordStreamStart(): void {
  streamStats.started++;
}

export function recordStreamCompleted(): void {
  streamStats.completed++;
}

export function recordStreamInterrupted(reason: string | null): void {
  streamStats.interrupted++;
  if (reason === 'missing_completion_marker') streamStats.missingCompletion++;
  else if (reason === 'idle_timeout') streamStats.idleTimeout++;
  else if (reason === 'reader_error') streamStats.readerError++;
}

export function __resetStreamStatsForTests(): void {
  for (const key of Object.keys(streamStats)) streamStats[key] = 0;
}

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

export function isCountedRoute(method: string, pathname: string): boolean {
  return COUNTED_ROUTES.has(`${method} ${pathname}`);
}

// Wrap a response so its completion updates the client counters, including
// streaming responses that finish after the handler has returned.
// The wrapper is lightweight: it only tracks close/cancel lifecycle for
// gateway-level stats — it does NOT parse SSE, find completion markers,
// rewrite model fields, or scan usage. Node-layer stream tracking
// (makeNodeStreamTrack) handles all protocol-level concerns.
export function trackClientResponse(response: Response): Response {
  const ok = response.status < 400;
  const streaming = ok && isOpenAIStreamingResponse(response) && response.body;
  if (!streaming) {
    gatewayStats.activeRequests = Math.max(0, gatewayStats.activeRequests - 1);
    if (ok) gatewayStats.successes++;
    else gatewayStats.failures++;
    return response;
  }
  // Streaming: wrap with a lightweight lifecycle that decrements activeRequests
  // and counts success/cancellation when the client-facing stream ends. The
  // inner trackStreamResponse already handles node-layer stats (node success,
  // streamStats, Tier1 slot) — this wrapper only manages client-level counters.
  const innerReader = response.body.getReader();
  let settled = false;
  const settle = (result: 'success' | 'failure' | 'cancel') => {
    if (settled) return;
    settled = true;
    gatewayStats.activeRequests = Math.max(0, gatewayStats.activeRequests - 1);
    if (result === 'success') gatewayStats.successes++;
    else if (result === 'failure') gatewayStats.failures++;
    else gatewayStats.cancellations++;
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await innerReader.read();
        if (done) {
          settle('success');
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch {
        settle('failure');
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() {
      settle('cancel');
      innerReader.cancel().catch(() => {});
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
