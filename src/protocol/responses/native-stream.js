// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Native OpenAI Responses stream helpers.
//
// The gateway forwards /v1/responses requests to a NATIVE /v1/responses
// upstream — there is no Chat Completions conversion anywhere in this path.
// These helpers cover the two defensive corners a native upstream can still
// present:
//   * collectResponsesObject     — upstream streamed although the client asked
//                                  for JSON: assemble the final response
//                                  object from the SSE event sequence.
//   * synthesizeResponsesFromObject — upstream answered JSON although the
//                                  client asked for a stream: emit a
//                                  well-formed Responses SSE event sequence.
//
// Nothing here touches scheduling / reliability. Failover semantics: both
// helpers run BEFORE any byte reaches the client, so a failure inside them
// still rotates to another node.

import { createSseScanner } from '../../stream/guard.js';
import { ResponsesEventBuilder } from './events.js';

const MAX_COLLECTED_BYTES = 2 * 1024 * 1024;

// Assemble the complete Responses object from an upstream Responses SSE
// stream. Terminal events own the result:
//   response.completed / response.incomplete -> resolve with `response`
//   response.failed                          -> throw (rotate; client saw nothing)
// EOF without a terminal event                -> throw (truncated stream)
export async function collectResponsesObject(upstream, clientSignal) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let collected = null;

  const fail = async (message) => {
    await reader.cancel().catch(() => {});
    throw new Error(message);
  };

  const scanner = createSseScanner((data) => {
    if (!data || data === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      throw Object.assign(new Error('Upstream returned malformed streaming data.'), { __cause: true });
    }
    if (json?.type === 'response.failed') {
      throw Object.assign(
        new Error(`Upstream reported response.failed: ${json.response?.error?.message || 'unknown error'}`),
        { __terminal_failure: true },
      );
    }
    if ((json?.type === 'response.completed' || json?.type === 'response.incomplete') && json.response) {
      collected = json.response;
    }
  });

  try {
    for (;;) {
      if (clientSignal?.aborted) await fail('Client aborted during stream assembly.');
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      scanner.push(decoder.decode(value, { stream: true }));
      if (receivedBytes > MAX_COLLECTED_BYTES) {
        await fail('Assembled response exceeded gateway memory safety limit. Use stream:true.');
      }
    }
    scanner.flush();
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }

  if (!collected) throw new Error('Upstream stream ended before a terminal response event.');
  return collected;
}

// Synthesize a complete, well-formed Responses SSE event sequence around a
// full Responses object (the "upstream answered JSON but the client wants a
// stream" case). Event order follows the Responses contract:
// response.created -> per-item added/delta/done -> response.completed.
export function synthesizeResponsesFromObject(response, requestedModel, extraHeaders) {
  const events = new ResponsesEventBuilder();
  const encoder = new TextEncoder();
  const chunks = [];
  const object = response && typeof response === 'object' ? response : {};
  if (object.model !== undefined) object.model = requestedModel;

  chunks.push(events.response_created({ ...object, status: 'in_progress' }));
  const output = Array.isArray(object.output) ? object.output : [];
  for (let i = 0; i < output.length; i++) {
    const item = output[i];
    const inProgress = { ...item, status: 'in_progress' };
    chunks.push(events.output_item_added(i, inProgress));
    if (item?.type === 'message') {
      const text = item.content?.[0]?.text || '';
      chunks.push(events.content_part_added(item.id, i));
      if (text) chunks.push(events.output_text_delta(item.id, i, text));
      chunks.push(events.output_text_done(item.id, i, text));
      chunks.push(events.content_part_done(item.id, i, text));
    } else if (item?.type === 'reasoning') {
      const text = item.content?.[0]?.text || '';
      if (text) {
        chunks.push(events.reasoning_text_delta(item.id, i, text));
        chunks.push(events.reasoning_text_done(item.id, i, text));
      }
    } else if (item?.type === 'function_call') {
      chunks.push(events.function_call_arguments_delta(item.id, i, item.arguments));
      chunks.push(events.function_call_arguments_done(item.id, i, item.arguments));
    }
    chunks.push(events.output_item_done(i, item));
  }
  chunks.push(object.status === 'incomplete' ? events.response_incomplete(object) : events.response_completed(object));

  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      ...(extraHeaders || {}),
    },
  });
}
