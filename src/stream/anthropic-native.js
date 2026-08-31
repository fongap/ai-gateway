// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Native Anthropic Messages stream helpers.
//
// The gateway forwards /v1/messages requests to a NATIVE /v1/messages
// upstream — there is no OpenAI Chat conversion anywhere in this path. These
// helpers cover the two defensive corners a native upstream can still
// present:
//   * collectAnthropicMessageObject  — upstream streamed although the client
//     asked for JSON: assemble the final message object from the SSE event
//     lifecycle.
//   * synthesizeAnthropicFromMessage — upstream answered JSON although the
//     client asked for a stream: emit a well-formed Anthropic SSE event
//     sequence.
//
// Nothing here touches scheduling / reliability. Failover semantics: both
// helpers run BEFORE any byte reaches the client, so a failure inside them
// still rotates to another node.

import { createSseScanner } from './guard.js';

const MAX_COLLECTED_BYTES = 2 * 1024 * 1024;

// Assemble a complete Anthropic message object from an upstream
// /v1/messages SSE stream (message_start -> content blocks -> message_delta
// -> message_stop). An upstream `error` event or a missing message_stop is a
// failure: nothing reached the client yet, so the caller can rotate.
export async function collectAnthropicMessageObject(upstream, clientSignal) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder(); // UTF-8 byte accounting only
  let receivedBytes = 0;
  let stopMessageStop = false;
  let messageBase = null; // { id, model }
  let stopReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  const blocks = [];
  // content_block_start state carries accumulated deltas per block index.
  const blockState = new Map();

  const fail = async (message) => {
    await reader.cancel().catch(() => {});
    throw new Error(message);
  };

  const countBytes = (value) => {
    if (value) receivedBytes += encoder.encode(value).length;
  };

  const scanner = createSseScanner((data) => {
    if (!data || data === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      throw Object.assign(new Error('Upstream returned malformed streaming data.'), { __cause: true });
    }
    if (receivedBytes > MAX_COLLECTED_BYTES) return; // enforced in the loop
    switch (json?.type) {
      case 'message_start': {
        messageBase = {
          id: json.message?.id,
          model: json.message?.model,
        };
        const startUsage = json.message?.usage;
        if (startUsage && typeof startUsage === 'object') {
          usage = { ...usage, input_tokens: Number(startUsage.input_tokens ?? usage.input_tokens) || usage.input_tokens };
        }
        break;
      }
      case 'content_block_start': {
        const index = Number(json.index ?? blocks.length);
        const block = json.content_block || {};
        blockState.set(index, { ...block });
        break;
      }
      case 'content_block_delta': {
        const index = Number(json.index ?? 0);
        const state = blockState.get(index);
        if (!state) break;
        const delta = json.delta || {};
        if (delta.type === 'text_delta') { state.text = (state.text || '') + (delta.text || ''); countBytes(delta.text); }
        else if (delta.type === 'thinking_delta') { state.thinking = (state.thinking || '') + (delta.thinking || ''); countBytes(delta.thinking); }
        else if (delta.type === 'signature_delta') { state.signature = (state.signature || '') + (delta.signature || ''); }
        else if (delta.type === 'input_json_delta') { state.partialJson = (state.partialJson || '') + (delta.partial_json || ''); countBytes(delta.partial_json); }
        break;
      }
      case 'content_block_stop': {
        const index = Number(json.index ?? blocks.length);
        const state = blockState.get(index);
        if (!state) break;
        blocks.push(anthropicBlockFromState(state));
        blockState.delete(index);
        break;
      }
      case 'message_delta': {
        if (json.delta?.stop_reason !== undefined) stopReason = json.delta.stop_reason;
        if (json.usage && typeof json.usage === 'object') {
          usage = {
            input_tokens: Number(json.usage.input_tokens ?? usage.input_tokens) || usage.input_tokens,
            output_tokens: Number(json.usage.output_tokens ?? usage.output_tokens) || usage.output_tokens,
          };
        }
        break;
      }
      case 'message_stop':
        stopMessageStop = true;
        break;
      case 'error':
        throw Object.assign(
          new Error(`Upstream reported an error event: ${json.error?.message || 'unknown error'}`),
          { __terminal_failure: true },
        );
      default:
        break; // ping and unknown event types are lifecycle noise
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

  if (!stopMessageStop) throw new Error('Upstream stream ended before message_stop was received.');
  if (blocks.length === 0) throw new Error('Upstream returned an empty streaming response.');
  return {
    id: messageBase?.id || `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model: messageBase?.model || '',
    content: blocks,
    stop_reason: stopReason || 'end_turn',
    stop_sequence: null,
    usage,
  };
}

function anthropicBlockFromState(state) {
  if (state.type === 'tool_use') {
    let input = {};
    const raw = state.partialJson || '{}';
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
    } catch { input = { _raw: raw }; }
    return { type: 'tool_use', id: state.id || '', name: state.name || 'unknown_tool', input };
  }
  if (state.type === 'thinking') {
    const block = { type: 'thinking', thinking: state.thinking || '' };
    if (state.signature) block.signature = state.signature;
    return block;
  }
  if (state.type === 'redacted_thinking') {
    return { type: 'redacted_thinking', data: state.data || '' };
  }
  return { type: 'text', text: state.text || '' };
}

// Synthesize a complete Anthropic SSE event sequence around a full message
// object (the "upstream answered JSON but the client wants a stream" case).
// Event order follows the Anthropic contract:
// message_start -> per-block start/delta/stop -> message_delta -> message_stop.
export function synthesizeAnthropicFromMessage(message, extraHeaders) {
  const encoder = new TextEncoder();
  const emit = (chunks, event, data) => chunks.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const object = message && typeof message === 'object' ? message : {};
  const content = Array.isArray(object.content) ? object.content : [];
  const usage = object.usage && typeof object.usage === 'object'
    ? { input_tokens: Number(object.usage.input_tokens ?? 0) || 0, output_tokens: Number(object.usage.output_tokens ?? 0) || 0 }
    : { input_tokens: 0, output_tokens: 0 };

  const chunks = [];
  emit(chunks, 'message_start', {
    type: 'message_start',
    message: {
      id: object.id || `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'message',
      role: 'assistant',
      model: object.model || '',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
    },
  });
  for (let index = 0; index < content.length; index++) {
    const block = content[index] || {};
    emit(chunks, 'content_block_start', { type: 'content_block_start', index, content_block: block });
    if (block.type === 'text' && block.text) {
      emit(chunks, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else if (block.type === 'thinking' && block.thinking) {
      emit(chunks, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      if (block.signature) {
        emit(chunks, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
      }
    } else if (block.type === 'tool_use') {
      emit(chunks, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
      });
    }
    emit(chunks, 'content_block_stop', { type: 'content_block_stop', index });
  }
  emit(chunks, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: object.stop_reason || 'end_turn', stop_sequence: null },
    usage,
  });
  emit(chunks, 'message_stop', { type: 'message_stop' });

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
