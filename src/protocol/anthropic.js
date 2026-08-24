// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Anthropic Messages surface: request validation, error responses, and the
// local /v1/messages/count_tokens approximation.

import { corsHeaders } from './http.js';

export function anthropicErrorTypeForStatus(status) {
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  return 'api_error';
}

export function anthropicErrorResponse(request, env, status, message, requestId, extraHeaders) {
  const error = { type: anthropicErrorTypeForStatus(status), message: String(message || 'Unknown gateway error.') };
  return new Response(JSON.stringify({ type: 'error', error }), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'request-id': requestId || '',
      'x-request-id': requestId || '',
      ...corsHeaders(request, env),
      ...(extraHeaders || {}),
    },
  });
}

export function validateAnthropicMessagesRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object.';
  if (!body.model || typeof body.model !== 'string') return 'model is required and must be a string.';
  if (!Number.isFinite(Number(body.max_tokens)) || Number(body.max_tokens) <= 0) return 'max_tokens is required and must be greater than 0.';
  if (!Array.isArray(body.messages)) return 'messages is required and must be an array.';
  return null;
}

export function validateAnthropicCountTokensRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object.';
  if (!body.model || typeof body.model !== 'string' || !body.model.trim()) return 'model is required and must be a non-empty string.';
  if (!Array.isArray(body.messages)) return 'messages is required and must be an array.';
  return null;
}

export function estimateAnthropicInputTokens(body) {
  let weightedChars = 0;
  const countText = (value) => { weightedChars += String(value || '').length; };
  if (typeof body.system === 'string') countText(body.system);
  else if (Array.isArray(body.system)) for (const x of body.system) countText(x?.text || x);
  for (const message of body.messages || []) {
    weightedChars += 8;
    if (typeof message.content === 'string') countText(message.content);
    else for (const block of message.content || []) {
      if (block?.type === 'text') countText(block.text);
      else if (block?.type === 'tool_use') countText(JSON.stringify(block.input || {}));
      else if (block?.type === 'tool_result') countText(toolResultToString(block.content, block.is_error));
      else if (block?.type === 'image') weightedChars += 6400;
      else countText(JSON.stringify(block));
    }
  }
  countText(JSON.stringify(body.tools || []));
  return Math.max(1, Math.ceil(weightedChars / 4));
}

function toolResultToString(content, isError) {
  const prefix = isError ? '[Tool execution error]\n' : '';
  if (content === undefined || content === null) return prefix;
  if (typeof content === 'string') return prefix + content;
  if (!Array.isArray(content)) return prefix + JSON.stringify(content);
  const parts = content.map((block) => {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return String(block ?? '');
    if (block.type === 'text') return block.text || '';
    if (block.type === 'image') return '[Tool-result image]';
    return JSON.stringify(block);
  });
  return prefix + parts.filter(Boolean).join('\n');
}
