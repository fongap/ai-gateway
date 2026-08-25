// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// OpenAI Responses protocol surface. Exposes only what the request handler
// needs; deep layout lives in request.js / response.js / stream.js / events.js
// / reasoning.js / tools.js.
//
// Responsibilities:
//   - inbound:  /v1/responses  request  -> OpenAI Chat Completions request
//   - outbound: OpenAI Chat Completions (object | SSE) -> /v1/responses
//               (object | SSE)
//   - errors:   OpenAI-compatible error envelope for /v1/responses
//
// It never touches node scheduling, cooldowns or the circuit breaker — that
// belongs to Scheduler / Reliability.

import { corsHeaders, shouldNotRetryHeaders } from '../http.js';
import { buildResponsesError, responsesErrorTypeForStatus } from './events.js';
import { responsesToOpenAIRequest, ResponseConversionError } from './request.js';
import { openAICompletionToResponses, buildResponsesResponse, buildOutputItems } from './response.js';
import { transformOpenAIStreamToResponses, synthesizeResponsesFromCompletion } from './stream.js';
import { buildReasoningItem, mapChatUsageToResponses } from './reasoning.js';
import {
  convertResponsesToolsToChat, convertResponsesToolChoice,
  normalizedFunctionCallArguments, buildFunctionCallItem, buildMessageItem,
  normalizeToolArguments,
} from './tools.js';

// Basic request shape validation. Converters may raise further errors (unsupported
// tool types) which the handler maps to a 400 before any upstream attempt.
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

export {
  responsesToOpenAIRequest,
  ResponseConversionError,
  openAICompletionToResponses,
  buildResponsesResponse,
  buildOutputItems,
  transformOpenAIStreamToResponses,
  synthesizeResponsesFromCompletion,
  buildResponsesError,
  responsesErrorTypeForStatus,
  buildReasoningItem,
  mapChatUsageToResponses,
  convertResponsesToolsToChat,
  convertResponsesToolChoice,
  normalizedFunctionCallArguments,
  buildFunctionCallItem,
  buildMessageItem,
  normalizeToolArguments,
};
