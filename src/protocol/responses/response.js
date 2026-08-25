// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// OpenAI Chat Completions object -> OpenAI Responses object (non-streaming).
// The reverse of request.js; reasoning, text and function calls each map to a
// distinct Responses output item so no content is flattened or lost.

import { extractOpenAITextContent } from '../openai.js';
import {
  extractReasoningText, extractReasoningSummary, extractEncryptedReasoning,
  buildReasoningItem, mapChatUsageToResponses,
} from './reasoning.js';
import { toolArgumentsToJson, buildFunctionCallItem, buildMessageItem } from './tools.js';

export function buildResponsesResponse({
  id, created_at, status, model, output = [], usage = {},
  error = null, incomplete_details = null, request = null,
}) {
  return {
    id,
    object: 'response',
    created_at,
    status,
    model,
    output,
    parallel_tool_calls: request?.parallel_tool_calls ?? true,
    tool_choice: normalizeToolChoiceEcho(request?.tool_choice),
    temperature: typeof request?.temperature === 'number' ? request.temperature : null,
    top_p: typeof request?.top_p === 'number' ? request.top_p : null,
    max_output_tokens: request?.max_output_tokens ?? null,
    usage,
    error,
    incomplete_details,
  };
}

export function openAICompletionToResponses(data, requestedModel, request) {
  if (!data || typeof data !== 'object') {
    throw new Error('Upstream returned no completion object to convert.');
  }
  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  const output = buildOutputItems(message, choice);
  const usage = mapChatUsageToResponses(data?.usage || {});
  const status = choice.finish_reason === 'length' ? 'incomplete' : 'completed';
  const incompleteDetails = status === 'incomplete' ? { reason: 'max_output_tokens' } : null;
  return buildResponsesResponse({
    id: normalizeResponsesId(data?.id),
    created_at: data?.created || Math.floor(Date.now() / 1000),
    status,
    model: requestedModel,
    output,
    usage,
    incomplete_details: incompleteDetails,
    request,
  });
}

export function buildOutputItems(message, choice = {}) {
  const items = [];
  const reasoningSource = message?.reasoning_content ?? message?.reasoning ?? choice.reasoning_content ?? choice.reasoning ?? {};
  const reasoningText = extractReasoningText(reasoningSource);
  const reasoningSummary = extractReasoningSummary(message) || extractReasoningSummary(choice);
  const encryptedReasoning = extractEncryptedReasoning(message) || extractEncryptedReasoning(choice) || extractEncryptedReasoning(reasoningSource);
  if (reasoningText || encryptedReasoning) {
    items.push(buildReasoningItem({
      id: newReasoningItemId(),
      text: reasoningText,
      summary: reasoningSummary,
      ...(encryptedReasoning ? { encrypted_content: encryptedReasoning } : {}),
    }));
  }
  const text = extractOpenAITextContent(message?.content);
  if (text) {
    items.push(buildMessageItem({ id: newMessageItemId(), text }));
  }
  const toolCalls = [];
  if (Array.isArray(message?.tool_calls)) {
    for (const call of message.tool_calls) {
      toolCalls.push({
        id: call.id || newCallId(),
        function: call.function || {},
      });
    }
  }
  if (message?.function_call) {
    toolCalls.push({ id: newCallId(), function: message.function_call });
  }
  for (const call of toolCalls) {
    items.push(buildFunctionCallItem({
      id: newFunctionCallItemId(),
      callId: call.id,
      name: call.function?.name || 'unknown_tool',
      argumentsJson: toolArgumentsToJson(call.function?.arguments),
    }));
  }
  return items;
}

function normalizeResponsesId(id) {
  const raw = String(id || '');
  if (raw.startsWith('resp_')) return raw;
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return `resp_${cleaned || crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function normalizeToolChoiceEcho(value) {
  if (value === undefined || value === null) return 'auto';
  if (typeof value === 'string') return value;
  return value;
}

export function normalizeResponsesIdInternal(id) {
  return normalizeResponsesId(id);
}

// ---- Stable output-item id generators --------------------------------------

export function newResponseId() {
  return `resp_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function newMessageItemId() {
  return `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function newReasoningItemId() {
  return `rs_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function newFunctionCallItemId() {
  return `fc_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function newCallId() {
  return `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}
