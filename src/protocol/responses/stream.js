// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// OpenAI Chat Completions SSE -> OpenAI Responses SSE streaming transform.
//
// This is the outbound half of the generic-provider conversion. Each upstream
// chunk is parsed once via the shared SSE scanner; a Responses event stream is
// emitted in the correct order: response.created (in_progress) first, then
// output items (reasoning / message / function_call) with their deltas and done
// events, then response.completed / response.incomplete / response.failed.
//
// Failover semantics: the caller runs the first-event guard on the raw upstream
// BEFORE feeding this transform. Response.created is synthesized here, so once
// this stream starts nothing is exchanged with the client until the guard has
// passed — meaning no transparent failover ever occurs mid-output.

import { extractOpenAITextContent } from '../openai.js';
import { createSseScanner } from '../../stream/guard.js';
import {
  buildReasoningItem, mapChatUsageToResponses,
  extractReasoningSummary, extractEncryptedReasoning,
} from './reasoning.js';
import { normalizedFunctionCallArguments, buildFunctionCallItem, buildMessageItem } from './tools.js';
import { ResponsesEventBuilder } from './events.js';
import {
  buildResponsesResponse, openAICompletionToResponses,
  newResponseId, newMessageItemId, newReasoningItemId, newFunctionCallItemId, newCallId,
} from './response.js';

export function transformOpenAIStreamToResponses(upstream, requestedModel, request, requestId, clientSignal) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const responseId = newResponseId();
  const createdAt = Math.floor(Date.now() / 1000);
  const events = new ResponsesEventBuilder();
  const outputs = [];
  let usage = {};
  let finishReason = null;
  let terminal = false;
  let validChoiceSeen = false;
  let activeText = null;
  let activeReasoning = null;
  let curReasoningSummary = '';
  let curReasoningEncrypted = '';
  const tools = new Map();
  const openItems = [];

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (str) => controller.enqueue(encoder.encode(str));

      const finishText = () => {
        if (!activeText) return;
        const text = activeText.parts.join('');
        const item = buildMessageItem({ id: activeText.itemId, text });
        outputs[activeText.outputIndex] = item;
        emit(events.output_text_done(activeText.itemId, activeText.outputIndex, text));
        emit(events.content_part_done(activeText.itemId, activeText.outputIndex, text));
        emit(events.output_item_done(activeText.outputIndex, item));
        removeOpen({ outputIndex: activeText.outputIndex });
        activeText = null;
      };
      const finishReasoning = () => {
        if (!activeReasoning) return;
        const text = activeReasoning.parts.join('');
        const item = buildReasoningItem({
          id: activeReasoning.itemId,
          text,
          summary: curReasoningSummary,
          ...(curReasoningEncrypted ? { encrypted_content: curReasoningEncrypted } : {}),
        });
        outputs[activeReasoning.outputIndex] = item;
        if (text) emit(events.reasoning_text_done(activeReasoning.itemId, activeReasoning.outputIndex, text));
        emit(events.output_item_done(activeReasoning.outputIndex, item));
        removeOpen({ outputIndex: activeReasoning.outputIndex });
        activeReasoning = null;
      };
      const finishContent = () => {
        finishText();
        finishReasoning();
      };
      const removeOpen = (pred) => {
        const idx = openItems.findIndex((o) => o.outputIndex === pred.outputIndex);
        if (idx >= 0) openItems.splice(idx, 1);
      };

      const startText = () => {
        const outputIndex = outputs.length;
        const itemId = newMessageItemId();
        outputs.push(null);
        emit(events.output_item_added(outputIndex, {
          id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [],
        }));
        emit(events.content_part_added(itemId, outputIndex));
        activeText = { itemId, outputIndex, parts: [] };
        openItems.push({ outputIndex, type: 'text' });
      };
      const startReasoning = () => {
        const outputIndex = outputs.length;
        const itemId = newReasoningItemId();
        outputs.push(null);
        emit(events.output_item_added(outputIndex, buildReasoningItem({ id: itemId, status: 'in_progress' })));
        activeReasoning = { itemId, outputIndex, parts: [] };
        curReasoningSummary = '';
        curReasoningEncrypted = '';
        openItems.push({ outputIndex, type: 'reasoning' });
      };

      const deltaReasoning = (text) => {
        if (activeText) finishText();
        if (!activeReasoning) startReasoning();
        activeReasoning.parts.push(text);
        emit(events.reasoning_text_delta(activeReasoning.itemId, activeReasoning.outputIndex, text));
      };
      const deltaText = (text) => {
        if (activeReasoning) finishReasoning();
        if (!activeText) startText();
        activeText.parts.push(text);
        emit(events.output_text_delta(activeText.itemId, activeText.outputIndex, text));
      };
      const deltaTools = (calls) => {
        if (activeText) finishText();
        if (activeReasoning) finishReasoning();
        for (const tc of calls || []) {
          const idx = Number(tc.index ?? 0);
          let st = tools.get(idx);
          if (!st) {
            const outputIndex = outputs.length;
            const itemId = newFunctionCallItemId();
            const callId = tc.id || newCallId();
            const name = tc.function?.name || 'unknown_tool';
            outputs.push(null);
            emit(events.output_item_added(outputIndex, {
              id: itemId, type: 'function_call', status: 'in_progress', call_id: callId, name,
            }));
            st = { itemId, outputIndex, callId, name, args: '' };
            tools.set(idx, st);
            openItems.push({ outputIndex, type: 'tool', toolIndex: idx });
          }
          if (tc.id) st.callId = tc.id;
          if (tc.function?.name) st.name = tc.function.name;
          if (typeof tc.function?.arguments === 'string' && tc.function.arguments) {
            st.args += tc.function.arguments;
            emit(events.function_call_arguments_delta(st.itemId, st.outputIndex, tc.function.arguments));
          }
        }
      };

      const finalizeTools = () => {
        const toolOpens = openItems
          .filter((o) => o.type === 'tool')
          .slice()
          .sort((a, b) => a.outputIndex - b.outputIndex);
        for (const open of toolOpens) {
          const st = tools.get(open.toolIndex);
          const args = st?.args ?? '{}';
          const normalized = normalizedFunctionCallArguments(args) ?? args;
          const item = buildFunctionCallItem({
            id: st.itemId, callId: st.callId, name: st.name, argumentsJson: normalized,
          });
          outputs[st.outputIndex] = item;
          emit(events.function_call_arguments_done(st.itemId, st.outputIndex, normalized));
          emit(events.output_item_done(st.outputIndex, item));
          removeOpen({ outputIndex: st.outputIndex });
        }
      };

      const finalize = () => {
        if (terminal) return;
        if (!validChoiceSeen) { fail('Upstream returned an empty or malformed stream.'); return; }
        finishContent();
        finalizeTools();
        if (terminal) return;
        terminal = true;
        const status = finishReason === 'length' ? 'incomplete' : 'completed';
        const incompleteDetails = status === 'incomplete' ? { reason: 'max_output_tokens' } : null;
        const response = buildResponsesResponse({
          id: responseId, created_at: createdAt, status, model: requestedModel,
          output: outputs.filter(Boolean), usage: mapChatUsageToResponses(usage),
          incomplete_details: incompleteDetails, request,
        });
        emit(status === 'incomplete' ? events.response_incomplete(response) : events.response_completed(response));
        try { controller.close(); } catch { /* already closed */ }
      };

      const fail = (message) => {
        if (terminal) return;
        finishContent();
        finalizeTools();
        if (terminal) return;
        terminal = true;
        const response = buildResponsesResponse({
          id: responseId, created_at: createdAt, status: 'failed', model: requestedModel,
          output: outputs.filter(Boolean), usage: mapChatUsageToResponses(usage),
          error: { message, type: 'api_error', param: null, code: null }, request,
        });
        emit(events.response_failed(response));
        try { controller.close(); } catch { /* already closed */ }
      };

      const processChunk = (json) => {
        if (json?.error) { fail(json.error.message || 'Upstream streaming error.'); return; }
        if (json?.usage) usage = json.usage;
        const choice = json?.choices?.[0];
        if (!choice) return;
        validChoiceSeen = true;
        const delta = choice.delta || {};
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? choice.reasoning_content;
        if (typeof reasoning === 'string' && reasoning) {
          curReasoningSummary = curReasoningSummary || extractReasoningSummary(choice) || extractReasoningSummary(delta);
          curReasoningEncrypted = curReasoningEncrypted || extractEncryptedReasoning(choice) || extractEncryptedReasoning(delta);
          deltaReasoning(reasoning);
        }
        const text = extractOpenAITextContent(delta.content);
        if (text) deltaText(text);
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) deltaTools(delta.tool_calls);
        if (delta.function_call) {
          deltaTools([{ index: 0, id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, function: delta.function_call }]);
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason;
      };

      emit(events.response_created(buildResponsesResponse({
        id: responseId, created_at: createdAt, status: 'in_progress', model: requestedModel,
        output: [], usage: {}, request,
      })));

      const scanner = createSseScanner((data) => {
        if (terminal) return;
        if (data === '[DONE]') {
          if (finishReason === null) fail('Upstream stream ended before a completion marker was received.');
          else finalize();
          return;
        }
        let json;
        try { json = JSON.parse(data); } catch { fail('Upstream returned malformed streaming data.'); return; }
        processChunk(json);
      });

      try {
        for (;;) {
          if (clientSignal?.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          scanner.push(decoder.decode(value, { stream: true }));
        }
        if (!terminal) scanner.flush();
        if (!terminal) {
          if (finishReason === null) fail('Upstream stream ended before a completion marker was received.');
          else finalize();
        }
      } catch (e) {
        if (!clientSignal?.aborted) fail(`Upstream stream interrupted: ${e?.message || e}`);
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
    cancel() {
      terminal = true;
      reader.cancel().catch(() => {});
    },
  });

  return sseResponse(stream);
}

// Full Responses SSE for the "upstream answered JSON but the client wants a
// stream" case: synthesize a complete, well-formed event sequence in one body.
export function synthesizeResponsesFromCompletion(data, requestedModel, request, extraHeaders) {
  const response = openAICompletionToResponses(data, requestedModel, request);
  const events = new ResponsesEventBuilder();
  const encoder = new TextEncoder();
  const chunks = [];
  chunks.push(events.response_created({ ...response, status: 'in_progress' }));
  for (let i = 0; i < response.output.length; i++) {
    const item = response.output[i];
    const inProgress = { ...item, status: 'in_progress' };
    chunks.push(events.output_item_added(i, inProgress));
    if (item.type === 'message') {
      const text = item.content?.[0]?.text || '';
      chunks.push(events.content_part_added(item.id, i));
      if (text) chunks.push(events.output_text_delta(item.id, i, text));
      chunks.push(events.output_text_done(item.id, i, text));
      chunks.push(events.content_part_done(item.id, i, text));
    } else if (item.type === 'reasoning') {
      const text = item.content?.[0]?.text || '';
      if (text) {
        chunks.push(events.reasoning_text_delta(item.id, i, text));
        chunks.push(events.reasoning_text_done(item.id, i, text));
      }
    } else if (item.type === 'function_call') {
      chunks.push(events.function_call_arguments_delta(item.id, i, item.arguments));
      chunks.push(events.function_call_arguments_done(item.id, i, item.arguments));
    }
    chunks.push(events.output_item_done(i, item));
  }
  chunks.push(response.status === 'incomplete' ? events.response_incomplete(response) : events.response_completed(response));

  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: sseHeaders(extraHeaders),
  });
}

function sseResponse(stream, extraHeaders) {
  return new Response(stream, { status: 200, headers: sseHeaders(extraHeaders) });
}

function sseHeaders(extraHeaders) {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    ...(extraHeaders || {}),
  };
}
