// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Gateway request counters and the client-facing stream accounting wrapper.
// All state is isolate-local best-effort.

import { isOpenAIStreamingResponse } from '../protocol/openai.ts';
import { SYNTHETIC_CLIENT_STREAM_HEADER } from '../stream/client-lifecycle.ts';

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
// trackClientResponse wrapper below never parses protocol events, so each
// protocol stream is still counted exactly once. Invariant:
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

// Wrap a response so its completion updates the CLIENT request counters.
// Protocol-aware real upstream streams already own that lifecycle through
// makeNodeStreamTrack; gateway-synthesized SSE streams do not. Only explicitly
// marked synthetic streams receive the lightweight relay wrapper below.
export function trackClientResponse(response: Response): Response {
  const ok = response.status < 400;
  const streaming = ok && isOpenAIStreamingResponse(response) && response.body;
  if (!streaming) {
    gatewayStats.activeRequests = Math.max(0, gatewayStats.activeRequests - 1);
    if (ok) gatewayStats.successes++;
    else gatewayStats.failures++;
    return response;
  }

  const synthetic = response.headers.get(SYNTHETIC_CLIENT_STREAM_HEADER) === '1';
  if (!synthetic) {
    // A real upstream / transformed stream is already wrapped by
    // trackStreamResponse. Returning it as-is avoids stacked pull wrappers and
    // preserves the established stream timing/cancellation contract.
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete(SYNTHETIC_CLIENT_STREAM_HEADER);

  const reader = response.body!.getReader();
  let finished = false;
  const finalize = (outcome: 'success' | 'failure' | 'cancel') => {
    if (finished) return;
    finished = true;
    gatewayStats.activeRequests = Math.max(0, gatewayStats.activeRequests - 1);
    if (outcome === 'success') gatewayStats.successes++;
    else if (outcome === 'failure') gatewayStats.failures++;
    else gatewayStats.cancellations++;
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finalize('success');
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        finalize('failure');
        controller.error(error);
      }
    },
    async cancel(reason) {
      finalize('cancel');
      try { await reader.cancel(reason); } catch { /* best-effort relay cleanup */ }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
