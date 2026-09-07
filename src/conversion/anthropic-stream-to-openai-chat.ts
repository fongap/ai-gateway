// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Anthropic Messages STREAM (SSE) -> OpenAI Chat Completions STREAM (SSE)
// converter.
//
// This is an INDEPENDENT stream converter. It does NOT import or reuse the
// existing reverse-direction stream converter (stream-converter.ts, which
// converts OpenAI Chat -> Anthropic) or any response converter. Stream and
// response conversions have distinct concerns and must not share mutable
// logic.
//
// First-Event Guard semantics (R0.3):
//   - `message_start` is a lifecycle event, NOT a commit boundary.
//   - `content_block_start` is a lifecycle event, NOT a commit boundary.
//   - A real `text_delta` (non-empty text) IS the commit boundary.
//   - A real `input_json_delta` (tool input) IS the commit boundary.
//
// Concretely: the converter MUST NOT buffer the entire upstream response
// before emitting. It must pipe the upstream SSE chunks through in real
// time, translating Anthropic event types to OpenAI Chat event types as
// they arrive. Only the `role: assistant` header delta is emitted before
// real output; that delta is itself a "non-meaningful" event for the
// OpenAI Chat first-event guard, so it does not close the failover
// boundary.

import { createSseScanner } from '../stream/guard.ts';
import { ConversionError } from './anthropic-to-openai.ts';

export { ConversionError };

// Map Anthropic stop_reason -> OpenAI Chat finish_reason.
function mapStopReason(reason: unknown): string {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'refusal':
    case 'pause_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

type ToolState = {
  index: number,
  id: string,
  name: string,
  arguments: string,
  started: boolean,
};

type State = {
  messageId: string,
  model: string,
  // role-only delta has been emitted; we send it once on the first content
  // event so the OpenAI Chat client sees a normal lifecycle.
  roleEmitted: boolean,
  // whether any real output (text_delta / input_json_delta / thinking_delta)
  // has been emitted to the controller. The First Event Guard sits ABOVE
  // this converter and uses this boundary to decide whether a transparent
  // failover is still allowed: if no real output was emitted, the guard
  // can rotate to another node.
  realOutputEmitted: boolean,
  textBlockOpen: boolean,
  textBlockIndex: number,
  toolsByAnthropicIndex: Map<number, ToolState>,
  finishReason: string | null,
  // last seen input_tokens from message_start, so message_delta can carry
  // prompt_tokens even if the upstream omits it later.
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  closed: boolean,
};

function createState(messageId: string, model: string, inputTokens: number): State {
  return {
    messageId,
    model,
    roleEmitted: false,
    realOutputEmitted: false,
    textBlockOpen: false,
    textBlockIndex: -1,
    toolsByAnthropicIndex: new Map(),
    finishReason: null,
    inputTokens,
    outputTokens: 0,
    totalTokens: 0,
    closed: false,
  };
}

function emitChunk(controller: ReadableStreamDefaultController<Uint8Array>, chunk: Record<string, unknown>): void {
  const payload = `data: ${JSON.stringify(chunk)}\n\n`;
  controller.enqueue(new TextEncoder().encode(payload));
}

function emitRoleHeader(state: State, controller: ReadableStreamDefaultController<Uint8Array>): void {
  if (state.roleEmitted) return;
  state.roleEmitted = true;
  emitChunk(controller, {
    id: state.messageId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });
}

function openTextBlock(state: State, controller: ReadableStreamDefaultController<Uint8Array>, index: number): void {
  if (state.textBlockOpen) return;
  state.textBlockOpen = true;
  state.textBlockIndex = index;
  // OpenAI Chat does not require an explicit "text block" header event; the
  // first text content delta carries the text. The role header has already
  // been emitted above.
  void controller;
}

function closeTextBlockIfOpen(state: State, controller: ReadableStreamDefaultController<Uint8Array>): void {
  if (!state.textBlockOpen) return;
  state.textBlockOpen = false;
  // No explicit close event in OpenAI Chat; the next tool_call delta carries
  // the boundary naturally. We still call the param a no-op to keep the
  // surface symmetric with openTextBlock.
  void state.textBlockIndex;
  void controller;
}

function startToolBlock(
  state: State,
  controller: ReadableStreamDefaultController<Uint8Array>,
  anthropicIndex: number,
  toolId: string,
  toolName: string,
): void {
  // Close any open text block before a tool block starts.
  closeTextBlockIfOpen(state, controller);
  const toolState: ToolState = { index: anthropicIndex, id: toolId, name: toolName, arguments: '', started: true };
  state.toolsByAnthropicIndex.set(anthropicIndex, toolState);
  emitRoleHeader(state, controller);
  // The first tool_call delta is a meaningful-output event for the
  // first-event guard (it carries a non-empty id), so it commits the
  // boundary just like a text_delta.
  state.realOutputEmitted = true;
  emitChunk(controller, {
    id: state.messageId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: anthropicIndex,
          id: toolId,
          type: 'function',
          function: { name: toolName, arguments: '' },
        }],
      },
      finish_reason: null,
    }],
  });
}

function appendToolArguments(
  state: State,
  controller: ReadableStreamDefaultController<Uint8Array>,
  anthropicIndex: number,
  partialJson: string,
): void {
  const tool = state.toolsByAnthropicIndex.get(anthropicIndex);
  if (!tool) {
    throw new ConversionError('conversion_not_supported: input_json_delta without a preceding tool_use block');
  }
  tool.arguments += partialJson;
  emitChunk(controller, {
    id: state.messageId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: anthropicIndex,
          function: { arguments: partialJson },
        }],
      },
      finish_reason: null,
    }],
  });
}

function emitFinishAndDone(state: State, controller: ReadableStreamDefaultController<Uint8Array>): void {
  if (state.closed) return;
  state.closed = true;
  // Final chunk carries finish_reason.
  emitChunk(controller, {
    id: state.messageId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{ index: 0, delta: {}, finish_reason: state.finishReason ?? 'stop' }],
  });
  // OpenAI Chat also emits a usage chunk (optional but expected by clients
  // that compute cost/usage). Best-effort: only when we have non-zero
  // numbers.
  const prompt = state.inputTokens;
  const completion = state.outputTokens;
  const total = state.totalTokens > 0 ? state.totalTokens : (prompt + completion);
  if (prompt > 0 || completion > 0) {
    emitChunk(controller, {
      id: state.messageId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [{ index: 0, delta: {}, finish_reason: state.finishReason ?? 'stop' }],
      usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total },
    });
  }
  controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
}

function processAnthropicEvent(state: State, controller: ReadableStreamDefaultController<Uint8Array>, evt: any): void {
  if (!evt || typeof evt !== 'object') return;
  const type = evt.type;
  switch (type) {
    case 'message_start': {
      // Lifecycle event — NOT a commit boundary. Just absorb and remember the
      // message id/model/input tokens for later use.
      const m = evt.message;
      if (m && typeof m === 'object') {
        if (typeof m.id === 'string') state.messageId = m.id;
        if (typeof m.model === 'string') state.model = m.model;
        if (m.usage && typeof m.usage === 'object') {
          state.inputTokens = Number(m.usage.input_tokens ?? 0) || 0;
          state.outputTokens = Number(m.usage.output_tokens ?? 0) || 0;
        }
      }
      return;
    }
    case 'content_block_start': {
      // Lifecycle event — NOT a commit boundary.
      const block = evt.content_block;
      if (block && typeof block === 'object' && block.type === 'tool_use') {
        const anthropicIndex = Number(evt.index ?? 0) || 0;
        const toolId = typeof block.id === 'string' ? block.id : '';
        const toolName = typeof block.name === 'string' ? block.name : '';
        if (!toolId || !toolName) {
          throw new ConversionError('conversion_not_supported: tool_use content_block_start missing id/name');
        }
        startToolBlock(state, controller, anthropicIndex, toolId, toolName);
      } else if (block && typeof block === 'object' && block.type === 'text') {
        openTextBlock(state, controller, Number(evt.index ?? 0) || 0);
      }
      return;
    }
    case 'content_block_delta': {
      const delta = evt.delta;
      if (!delta || typeof delta !== 'object') return;
      if (delta.type === 'text_delta') {
        const text = typeof delta.text === 'string' ? delta.text : '';
        if (!text) return;
        // Commit-worthy event. Open the text block (idempotent) and emit the
        // role header (idempotent) before the first real delta, so the
        // OpenAI Chat client sees a normal lifecycle.
        emitRoleHeader(state, controller);
        if (!state.textBlockOpen) state.textBlockOpen = true;
        state.realOutputEmitted = true;
        emitChunk(controller, {
          id: state.messageId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: state.model,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        });
        return;
      }
      if (delta.type === 'input_json_delta') {
        const partial = typeof delta.partial_json === 'string' ? delta.partial_json : '';
        const anthropicIndex = Number(evt.index ?? 0) || 0;
        if (!partial) return;
        appendToolArguments(state, controller, anthropicIndex, partial);
        state.realOutputEmitted = true;
        return;
      }
      if (delta.type === 'thinking_delta') {
        // OpenAI Chat has a `reasoning` field on delta. We surface it so
        // reasoning-aware clients can display it; the first-event guard
        // treats non-empty reasoning as real output, which is correct.
        const thinking = typeof delta.thinking === 'string' ? delta.thinking : '';
        if (!thinking) return;
        emitRoleHeader(state, controller);
        state.realOutputEmitted = true;
        emitChunk(controller, {
          id: state.messageId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: state.model,
          choices: [{ index: 0, delta: { reasoning: thinking }, finish_reason: null }],
        });
        return;
      }
      if (delta.type === 'signature_delta' || delta.type === 'citation_delta') {
        // No OpenAI Chat equivalent for Anthropic signature/citation deltas.
        // We do NOT throw here — the model produced reasoning alongside
        // these deltas and the client already received the text. We drop the
        // deltas and continue; the response converter is still strict (throws
        // on thinking blocks for the non-streaming path) because the
        // non-streaming contract demands lossless conversion.
        return;
      }
      return;
    }
    case 'content_block_stop': {
      // Lifecycle event. Close any open text block.
      closeTextBlockIfOpen(state, controller);
      return;
    }
    case 'message_delta': {
      // Carries stop_reason + final usage.
      if (evt.delta && typeof evt.delta === 'object' && evt.delta.stop_reason) {
        state.finishReason = mapStopReason(evt.delta.stop_reason);
      }
      if (evt.usage && typeof evt.usage === 'object') {
        state.inputTokens = Number(evt.usage.input_tokens ?? state.inputTokens) || state.inputTokens;
        state.outputTokens = Number(evt.usage.output_tokens ?? state.outputTokens) || state.outputTokens;
        if (typeof evt.usage.total_tokens === 'number') {
          state.totalTokens = evt.usage.total_tokens;
        }
      }
      return;
    }
    case 'message_stop': {
      // Terminal event — emit finish + DONE.
      emitFinishAndDone(state, controller);
      return;
    }
    case 'ping':
      // Heartbeat. No-op.
      return;
    case 'error': {
      // Upstream Anthropic error envelope. We surface it to the controller so
      // the OpenAI Chat client sees a clear final error chunk.
      const errMsg = typeof evt.error?.message === 'string' ? evt.error.message : 'upstream_error';
      emitChunk(controller, { error: { message: errMsg, type: evt.error?.type || 'api_error' } });
      return;
    }
    default:
      // Unknown event types are silently dropped at the stream layer to
      // maintain forward compatibility with new Anthropic event types. The
      // non-streaming response converter is the strict (lossless) path.
      return;
  }
}

// Build an OpenAI Chat Completions SSE stream from an Anthropic Messages SSE
// stream. Real-time conversion — no buffering of the full response. Returns
// a ReadableStream that emits standard OpenAI Chat chunks (delta.role /
// delta.content / delta.tool_calls / finish_reason / [DONE]).
export function createOpenAIChatStreamFromAnthropic(
  anthropicResponseBody: ReadableStream<Uint8Array> | null | undefined,
  options: { messageId?: string, model?: string, inputTokens?: number } = {},
): ReadableStream<Uint8Array> {
  const { messageId, model, inputTokens } = options;
  const state = createState(
    messageId || `chatcmpl-${Date.now().toString(36)}`,
    model || '',
    Number(inputTokens ?? 0) || 0,
  );

  return new ReadableStream({
    async start(controller) {
      if (!anthropicResponseBody || !anthropicResponseBody.getReader) {
        controller.error(new Error('Anthropic stream body is not readable'));
        return;
      }
      const reader = anthropicResponseBody.getReader();
      const decoder = new TextDecoder();
      const onAnthropicEvent = (data: string) => {
        if (!data) return;
        let evt: any;
        try { evt = JSON.parse(data); } catch { return; }
        try {
          processAnthropicEvent(state, controller, evt);
        } catch (e) {
          if (!state.closed) {
            state.closed = true;
            try { controller.error(e); } catch { /* already closed */ }
          }
        }
      };
      const scanner = createSseScanner(onAnthropicEvent);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          scanner.push(decoder.decode(value, { stream: true }));
        }
        scanner.flush();
        // End-of-stream handling. We MUST NOT commit the first-event boundary
        // when no real output was emitted: the First Event Guard above this
        // converter is the layer that decides whether the request is allowed
        // to rotate to another node. Emitting a finish + [DONE] here would
        // tell the client the stream is done even though no model output was
        // ever produced — that would close the failover boundary incorrectly.
        if (!state.closed) {
          if (state.realOutputEmitted) {
            if (!state.finishReason) state.finishReason = 'stop';
            emitFinishAndDone(state, controller);
          }
        }
        controller.close();
      } catch (e) {
        if (!state.closed) {
          state.closed = true;
          try { controller.error(e); } catch { /* already closed */ }
        }
      }
    },
  });
}
