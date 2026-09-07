// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Anthropic Messages STREAM (SSE) -> OpenAI Responses STREAM (SSE)
// converter (R0.6 / Codex path).
//
// This is an INDEPENDENT stream converter. It does NOT import or reuse the
// existing OpenAI Chat stream converter (anthropic-stream-to-openai-chat.ts)
// or the response converters. Responses and Chat have distinct SSE event
// names; they must be assembled separately.
//
// First-Event Guard semantics (R0.3 contract, applied to Responses):
//   - `message_start` is a lifecycle event, NOT a commit boundary.
//   - `content_block_start` is a lifecycle event, NOT a commit boundary.
//   - A real `text_delta` (non-empty text) IS the commit boundary.
//   - A real `input_json_delta` (tool input) IS the commit boundary.
//
// Concretely: the converter pipes Anthropic SSE chunks through in real
// time, translating to Responses events as they arrive. The first
// Responses event the client sees is `response.created` (lifecycle), which
// the Responses first-event guard does NOT treat as real output. The
// `response.output_text.delta` / `response.function_call_arguments.delta`
// events are the commit points.

import { createSseScanner } from '../stream/guard.ts';
import { ConversionError } from './anthropic-to-openai.ts';

export { ConversionError };

function mapStopReasonToStatus(stopReason: unknown): 'completed' | 'failed' | 'incomplete' {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'tool_use':
      return 'completed';
    case 'max_tokens':
      return 'incomplete';
    case 'refusal':
      return 'failed';
    default:
      return 'completed';
  }
}

type ToolState = {
  // Anthropic block index (from content_block_start / content_block_delta)
  anthropicIndex: number,
  callId: string,
  name: string,
  // Anthropic item id (rs_xxx) for Responses output_item.* events
  itemId: string,
  // Whether we have emitted response.output_item.added for this tool yet
  itemAdded: boolean,
  arguments: string,
};

type State = {
  responseId: string,
  model: string,
  createdAt: number,
  // Sequence number counter. The Responses wire format requires strictly
  // increasing sequence_number across the whole response.
  sequence: number,
  // Whether the response.created event has been emitted.
  created: boolean,
  // Current message item being assembled (Responses message item).
  messageItemId: string | null,
  // Whether we've emitted response.output_item.added for the current message.
  messageItemAdded: boolean,
  messageTextAccumulated: string,
  // Whether any real output (text_delta / input_json_delta) has been emitted
  // to the controller. Used to keep the first-event boundary open.
  realOutputEmitted: boolean,
  // Tool calls in progress, keyed by Anthropic content block index.
  toolsByIndex: Map<number, ToolState>,
  // Final stop_reason seen in message_delta.
  finalStatus: 'completed' | 'failed' | 'incomplete',
  // Final usage seen in message_delta.
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  // Whether the terminal event (response.completed / response.failed) has
  // been emitted to the controller.
  closed: boolean,
};

function createState(responseId: string, model: string, createdAt: number, inputTokens: number): State {
  return {
    responseId,
    model,
    createdAt,
    sequence: 0,
    created: false,
    messageItemId: null,
    messageItemAdded: false,
    messageTextAccumulated: '',
    realOutputEmitted: false,
    toolsByIndex: new Map(),
    finalStatus: 'completed',
    inputTokens,
    outputTokens: 0,
    totalTokens: 0,
    closed: false,
  };
}

function nextSeq(state: State): number {
  return state.sequence++;
}

function emitEvent(controller: ReadableStreamDefaultController<Uint8Array>, name: string, data: Record<string, unknown>): void {
  controller.enqueue(new TextEncoder().encode(
    `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
  ));
}

function emitResponseCreated(state: State, controller: ReadableStreamDefaultController<Uint8Array>): void {
  if (state.created) return;
  state.created = true;
  emitEvent(controller, 'response.created', {
    type: 'response.created',
    sequence_number: nextSeq(state),
    response: {
      id: state.responseId,
      object: 'response',
      created_at: state.createdAt,
      status: 'in_progress',
      model: state.model,
      output: [],
      usage: { input_tokens: state.inputTokens, output_tokens: 0, total_tokens: state.inputTokens },
    },
  });
}

function ensureMessageItem(state: State, controller: ReadableStreamDefaultController<Uint8Array>): string {
  if (state.messageItemId && state.messageItemAdded) return state.messageItemId;
  const itemId = state.messageItemId || `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  state.messageItemId = itemId;
  if (!state.messageItemAdded) {
    emitEvent(controller, 'response.output_item.added', {
      type: 'response.output_item.added',
      sequence_number: nextSeq(state),
      output_index: nextOutputIndex(state),
      item: {
        id: itemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    });
    state.messageItemAdded = true;
  }
  return itemId;
}

// Find the next output index for a new output item. Tools and message items
// share the index space. We track the high-water mark via the State shape.
function nextOutputIndex(state: State): number {
  // We don't maintain a separate counter; the caller uses toolsByIndex.size
  // + (messageItemId ? 1 : 0) implicitly by tracking the explicit index
  // on the item. For simplicity we return 0 for message and 1+ for tools
  // in order; this matches the typical Responses stream layout.
  // NOTE: A more robust implementation would track per-item indices; for
  // the R0.6 subset the typical case is one message item followed by zero
  // or more tool_call items, so a simple monotonic counter is sufficient.
  let maxIdx = -1;
  for (const tool of state.toolsByIndex.values()) {
    if (tool.anthropicIndex > maxIdx) maxIdx = tool.anthropicIndex;
  }
  return maxIdx + 1;
}

function startToolItem(
  state: State,
  controller: ReadableStreamDefaultController<Uint8Array>,
  anthropicIndex: number,
  toolId: string,
  toolName: string,
): void {
  // Close any open message item (Responses expects output items to be
  // finalized before a new one is opened). When the message has no
  // accumulated text, we still need to emit a completed message item so
  // the wire sequence is well-formed; some clients tolerate an empty
  // message item, others require a content_block_stop-equivalent.
  if (state.messageItemId && state.messageItemAdded) {
    emitEvent(controller, 'response.output_item.done', {
      type: 'response.output_item.done',
      sequence_number: nextSeq(state),
      output_index: anthropicIndex, // re-use the index namespace
      item: {
        id: state.messageItemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: state.messageTextAccumulated
          ? [{ type: 'output_text', text: state.messageTextAccumulated, annotations: [] }]
          : [],
      },
    });
    // Reset so a future text block (rare in tool flows) starts a new item.
    state.messageItemId = null;
    state.messageItemAdded = false;
    state.messageTextAccumulated = '';
  }
  const itemId = `fc_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const tool: ToolState = { anthropicIndex, callId: toolId, name: toolName, itemId, itemAdded: true, arguments: '' };
  state.toolsByIndex.set(anthropicIndex, tool);
  emitEvent(controller, 'response.output_item.added', {
    type: 'response.output_item.added',
    sequence_number: nextSeq(state),
    output_index: anthropicIndex,
    item: {
      id: itemId,
      type: 'function_call',
      status: 'in_progress',
      call_id: toolId,
      name: toolName,
      arguments: '',
    },
  });
}

function appendToolArguments(
  state: State,
  controller: ReadableStreamDefaultController<Uint8Array>,
  anthropicIndex: number,
  partial: string,
): void {
  const tool = state.toolsByIndex.get(anthropicIndex);
  if (!tool) {
    throw new ConversionError('conversion_not_supported: input_json_delta without a preceding tool_use block');
  }
  tool.arguments += partial;
  emitEvent(controller, 'response.function_call_arguments.delta', {
    type: 'response.function_call_arguments.delta',
    sequence_number: nextSeq(state),
    item_id: tool.itemId,
    output_index: anthropicIndex,
    delta: partial,
  });
}

function processAnthropicEvent(state: State, controller: ReadableStreamDefaultController<Uint8Array>, evt: any): void {
  if (!evt || typeof evt !== 'object') return;
  const type = evt.type;
  switch (type) {
    case 'message_start': {
      const m = evt.message;
      if (m && typeof m === 'object') {
        if (typeof m.id === 'string') state.responseId = m.id;
        if (typeof m.model === 'string') state.model = m.model;
        if (m.usage && typeof m.usage === 'object') {
          state.inputTokens = Number(m.usage.input_tokens ?? 0) || 0;
          state.outputTokens = Number(m.usage.output_tokens ?? 0) || 0;
        }
      }
      // Emit response.created lazily on the first real output (to keep
      // the first-event boundary open). Some clients expect response.created
      // to come first; we emit it lazily so a stream with only lifecycle
      // events never commits the boundary.
      return;
    }
    case 'content_block_start': {
      const block = evt.content_block;
      const index = Number(evt.index ?? 0) || 0;
      if (block && typeof block === 'object' && block.type === 'tool_use') {
        const toolId = typeof block.id === 'string' ? block.id : '';
        const toolName = typeof block.name === 'string' ? block.name : '';
        if (!toolId || !toolName) {
          throw new ConversionError('conversion_not_supported: tool_use content_block_start missing id/name');
        }
        // First real output — emit response.created now (idempotent).
        emitResponseCreated(state, controller);
        startToolItem(state, controller, index, toolId, toolName);
      } else if (block && typeof block === 'object' && block.type === 'text') {
        // Lifecycle only; do not commit. The text content arrives as
        // text_delta events, which commit the boundary.
        if (!state.messageItemId) {
          state.messageItemId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        }
      } else {
        // Unknown / unsupported content type. Reject rather than silently
        // drop, per R0.6 contract.
        throw new ConversionError(`conversion_not_supported: content_block_start type "${String((block as any)?.type)}" is not supported`);
      }
      return;
    }
    case 'content_block_delta': {
      const delta = evt.delta;
      if (!delta || typeof delta !== 'object') return;
      if (delta.type === 'text_delta') {
        const text = typeof delta.text === 'string' ? delta.text : '';
        if (!text) return;
        // Commit-worthy event. Emit response.created + output_item.added +
        // output_text.delta in the right order.
        emitResponseCreated(state, controller);
        const itemId = ensureMessageItem(state, controller);
        state.messageTextAccumulated += text;
        state.realOutputEmitted = true;
        emitEvent(controller, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          sequence_number: nextSeq(state),
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: text,
        });
        return;
      }
      if (delta.type === 'input_json_delta') {
        const partial = typeof delta.partial_json === 'string' ? delta.partial_json : '';
        const index = Number(evt.index ?? 0) || 0;
        if (!partial) return;
        emitResponseCreated(state, controller);
        if (!state.toolsByIndex.has(index)) {
          // Defensive: some Anthropic streams may send input_json_delta
          // before content_block_start completes the tool_use block. We
          // surface this as a conversion error rather than silently
          // creating a tool with no id/name.
          throw new ConversionError('conversion_not_supported: input_json_delta for unknown tool_use block');
        }
        appendToolArguments(state, controller, index, partial);
        state.realOutputEmitted = true;
        return;
      }
      if (delta.type === 'thinking_delta' || delta.type === 'signature_delta') {
        // No Responses equivalent; reject to keep the lossless contract.
        throw new ConversionError('conversion_not_supported: thinking blocks cannot be losslessly streamed to OpenAI Responses');
      }
      return;
    }
    case 'content_block_stop': {
      // Finalize any open items that the current block represented.
      const index = Number(evt.index ?? 0) || 0;
      if (state.messageItemId && state.messageItemAdded && index === 0) {
        // We don't track the Anthropic index of the message item; on
        // R0.6 the typical case is a single text block. We finalize
        // only when no tools are open and this is the closing stop.
        if (state.toolsByIndex.size === 0) {
          emitEvent(controller, 'response.output_text.done', {
            type: 'response.output_text.done',
            sequence_number: nextSeq(state),
            item_id: state.messageItemId,
            output_index: 0,
            content_index: 0,
            text: state.messageTextAccumulated,
          });
          emitEvent(controller, 'response.output_item.done', {
            type: 'response.output_item.done',
            sequence_number: nextSeq(state),
            output_index: 0,
            item: {
              id: state.messageItemId,
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: state.messageTextAccumulated
                ? [{ type: 'output_text', text: state.messageTextAccumulated, annotations: [] }]
                : [],
            },
          });
          state.messageItemAdded = false;
        }
      }
      const tool = state.toolsByIndex.get(index);
      if (tool) {
        emitEvent(controller, 'response.output_item.done', {
          type: 'response.output_item.done',
          sequence_number: nextSeq(state),
          output_index: index,
          item: {
            id: tool.itemId,
            type: 'function_call',
            status: 'completed',
            call_id: tool.callId,
            name: tool.name,
            arguments: tool.arguments,
          },
        });
      }
      return;
    }
    case 'message_delta': {
      if (evt.delta && typeof evt.delta === 'object' && evt.delta.stop_reason) {
        state.finalStatus = mapStopReasonToStatus(evt.delta.stop_reason);
      }
      if (evt.usage && typeof evt.usage === 'object') {
        state.inputTokens = Number(evt.usage.input_tokens ?? state.inputTokens) || state.inputTokens;
        state.outputTokens = Number(evt.usage.output_tokens ?? state.outputTokens) || state.outputTokens;
        if (typeof evt.usage.total_tokens === 'number') state.totalTokens = evt.usage.total_tokens;
      }
      return;
    }
    case 'message_stop': {
      // Emit response.completed with the assembled output.
      emitResponseCreated(state, controller);
      if (state.messageItemId && state.messageItemAdded) {
        emitEvent(controller, 'response.output_text.done', {
          type: 'response.output_text.done',
          sequence_number: nextSeq(state),
          item_id: state.messageItemId,
          output_index: 0,
          content_index: 0,
          text: state.messageTextAccumulated,
        });
        emitEvent(controller, 'response.output_item.done', {
          type: 'response.output_item.done',
          sequence_number: nextSeq(state),
          output_index: 0,
          item: {
            id: state.messageItemId,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: state.messageTextAccumulated
              ? [{ type: 'output_text', text: state.messageTextAccumulated, annotations: [] }]
              : [],
          },
        });
        state.messageItemAdded = false;
      }
      const outputItems: Array<Record<string, unknown>> = [];
      if (state.messageItemId) {
        outputItems.push({
          id: state.messageItemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: state.messageTextAccumulated
            ? [{ type: 'output_text', text: state.messageTextAccumulated, annotations: [] }]
            : [],
        });
      }
      for (const tool of state.toolsByIndex.values()) {
        outputItems.push({
          id: tool.itemId,
          type: 'function_call',
          status: 'completed',
          call_id: tool.callId,
          name: tool.name,
          arguments: tool.arguments,
        });
      }
      const totalTokens = state.totalTokens > 0 ? state.totalTokens : (state.inputTokens + state.outputTokens);
      emitEvent(controller, 'response.completed', {
        type: 'response.completed',
        sequence_number: nextSeq(state),
        response: {
          id: state.responseId,
          object: 'response',
          created_at: state.createdAt,
          status: state.finalStatus,
          model: state.model,
          output: outputItems,
          usage: { input_tokens: state.inputTokens, output_tokens: state.outputTokens, total_tokens: totalTokens },
        },
      });
      state.closed = true;
      return;
    }
    case 'error': {
      // Upstream Anthropic error envelope. Surface to the client as a
      // Responses error event (response.failed) so the Codex client can
      // handle it through its normal error path.
      const errMsg = typeof evt.error?.message === 'string' ? evt.error.message : 'upstream_error';
      emitResponseCreated(state, controller);
      emitEvent(controller, 'response.failed', {
        type: 'response.failed',
        sequence_number: nextSeq(state),
        response: {
          id: state.responseId,
          object: 'response',
          created_at: state.createdAt,
          status: 'failed',
          model: state.model,
          error: { message: errMsg, type: evt.error?.type || 'api_error' },
        },
      });
      state.closed = true;
      return;
    }
    case 'ping':
      return;
    default:
      return;
  }
}

// Build an OpenAI Responses SSE stream from an Anthropic Messages SSE
// stream. Real-time conversion — no buffering of the full response.
// Returns a ReadableStream that emits standard Responses events
// (response.created / response.output_item.added / response.output_text.delta
// / response.output_text.done / response.output_item.done /
// response.function_call_arguments.delta / response.completed /
// response.failed).
export function createResponsesStreamFromAnthropic(
  anthropicResponseBody: ReadableStream<Uint8Array> | null | undefined,
  options: { responseId?: string, model?: string, createdAt?: number, inputTokens?: number } = {},
): ReadableStream<Uint8Array> {
  const { responseId, model, createdAt, inputTokens } = options;
  const state = createState(
    responseId || `resp_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    model || '',
    Number(createdAt ?? 1) || 1,
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
      const onEvent = (data: string) => {
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
      const scanner = createSseScanner(onEvent);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          scanner.push(decoder.decode(value, { stream: true }));
        }
        scanner.flush();
        // If the upstream ended without message_stop and no real output was
        // emitted, do not commit the first-event boundary — the upstream
        // First Event Guard layer will rotate. If real output was emitted,
        // close cleanly with a response.completed (if not already).
        if (!state.closed) {
          if (state.realOutputEmitted) {
            emitResponseCreated(state, controller);
            if (state.messageItemId && state.messageItemAdded) {
              emitEvent(controller, 'response.output_text.done', {
                type: 'response.output_text.done',
                sequence_number: nextSeq(state),
                item_id: state.messageItemId,
                output_index: 0,
                content_index: 0,
                text: state.messageTextAccumulated,
              });
              emitEvent(controller, 'response.output_item.done', {
                type: 'response.output_item.done',
                sequence_number: nextSeq(state),
                output_index: 0,
                item: {
                  id: state.messageItemId,
                  type: 'message',
                  status: 'completed',
                  role: 'assistant',
                  content: state.messageTextAccumulated
                    ? [{ type: 'output_text', text: state.messageTextAccumulated, annotations: [] }]
                    : [],
                },
              });
            }
            const total = state.totalTokens > 0 ? state.totalTokens : (state.inputTokens + state.outputTokens);
            emitEvent(controller, 'response.completed', {
              type: 'response.completed',
              sequence_number: nextSeq(state),
              response: {
                id: state.responseId,
                object: 'response',
                created_at: state.createdAt,
                status: state.finalStatus,
                model: state.model,
                output: [],
                usage: { input_tokens: state.inputTokens, output_tokens: state.outputTokens, total_tokens: total },
              },
            });
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
