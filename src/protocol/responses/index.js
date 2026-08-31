// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// OpenAI Responses protocol surface (NATIVE).
//
// The gateway forwards /v1/responses client requests to a NATIVE
// /v1/responses upstream endpoint. There is NO conversion to or from Chat
// Completions anywhere in this path.
//
// Responsibilities:
//   - inbound:  /v1/responses request shape validation
//   - errors:   OpenAI-compatible error envelope for /v1/responses
//   - native:   defensive stream<->object helpers for native upstreams
//
// It never touches node scheduling, cooldowns or the circuit breaker — that
// belongs to Scheduler / Reliability.

import { corsHeaders, shouldNotRetryHeaders } from '../http.js';
import { buildResponsesError, responsesErrorTypeForStatus } from './events.js';
import { collectResponsesObject, synthesizeResponsesFromObject } from './native-stream.js';

// Basic request shape validation. The request body is forwarded NATIVELY to
// the upstream, so this gateway only checks the minimum contract (model +
// input); field-level semantics are the upstream's job. Requests that do not
// satisfy the shape are rejected with a 400 before any upstream attempt.
export function validateOpenAIResponsesRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object.';
  if (!body.model || typeof body.model !== 'string' || !body.model.trim()) return 'model is required and must be a non-empty string.';
  if (body.input === undefined || body.input === null) return 'input is required.';
  return null;
}

export function responsesErrorResponse(request, env, status, message, requestId, extraHeaders) {
  const body = buildResponsesError(message, responsesErrorTypeForStatus(status));
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'x-request-id': requestId || '',
      ...(extraHeaders || {}),
      ...shouldNotRetryHeaders(status),
      ...corsHeaders(request, env),
    },
  });
}

export { buildResponsesError, responsesErrorTypeForStatus };
export { ResponsesEventBuilder, formatResponsesSseEvent } from './events.js';
export { collectResponsesObject, synthesizeResponsesFromObject };
