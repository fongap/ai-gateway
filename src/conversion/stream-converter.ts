// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// OpenAI Chat Completions SSE stream -> Anthropic Messages SSE stream converter.

import { convertSseStream } from './sse.ts';
import { isRecord } from './validation.ts';
import { convertOpenAIUsageToAnthropic } from './openai-to-anthropic.ts';

function mapFinishReason(reason: unknown): string {
  switch (reason) {
    case 'stop':
    case 'content_filter':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}

function createAnthropicMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

type ToolBlockState = {
  index: number,
  id: string,
  name: string,
  arguments: string,
  opened: boolean,
  closed: boolean,
};

export function createAnthropicStreamFromOpenAI(
  openAiResponseBody: ReadableStream<Uint8Array> | null | undefined,
  options: {
    messageId?: string,
    model?: string,
    inputTokens?: number,
    onUpstreamUsage?: (usage: unknown) => void,
  } = {},
): ReadableStream<Uint8Array> {
  const { messageId, model, inputTokens, onUpstreamUsage } = options;
  const finalMessageId = messageId || createAnthropicMessageId();
  const encoder = new TextEncoder();

  const state: {
    messageId: string,
    model: string,
    inputTokens: number,
    messageStarted: boolean,
    textBlockOpened: boolean,
    textBlockClosed: boolean,
    toolBlocks: Map<number, ToolBlockState>,
    blockIndex: number,
    usage: unknown,
    upstreamUsage: unknown,
    finishReason: unknown,
    closed: boolean,
    textIndex?: number,
  } = {
    messageId: finalMessageId,
    model: model || '',
    inputTokens: Number(inputTokens ?? 0) || 0,
    messageStarted: false,
    textBlockOpened: false,
    textBlockClosed: false,
    toolBlocks: new Map(),
    blockIndex: 0,
    usage: null,
    upstreamUsage: null,
    finishReason: null,
    closed: false,
  };


  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown) => {
    if (state.closed) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    controller.enqueue(encoder.encode(payload));
  };

  const emitMessageStart = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (state.messageStarted) return;
    state.messageStarted = true;
    emit(controller, 'message_start', {
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: state.inputTokens, output_tokens: 0 },
      },
    });
  };

  const openTextBlock = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (state.textBlockOpened && !state.textBlockClosed) return;
    state.textBlockClosed = false;
    state.textBlockOpened = true;
    emitMessageStart(controller);
    const index = state.blockIndex++;
    emit(controller, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    });
    state.textIndex = index;
  };

  const closeTextBlock = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (!state.textBlockOpened || state.textBlockClosed) return;
    state.textBlockClosed = true;
    emit(controller, 'content_block_stop', {
      type: 'content_block_stop',
      index: state.textIndex,
    });
  };

  const openToolBlock = (controller: ReadableStreamDefaultController<Uint8Array>, toolCall: { id?: string, index?: number, function?: { name?: string, arguments?: string } }): ToolBlockState => {
    const index = state.blockIndex++;
    const toolState: ToolBlockState = {
      index,
      id: toolCall.id || '',
      name: toolCall.function?.name || '',
      arguments: '',
      opened: true,
      closed: false,
    };
    state.toolBlocks.set(toolCall.index ?? 0, toolState);
    emit(controller, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool_use',
        id: toolState.id,
        name: toolState.name,
        input: {},
      },
    });
    return toolState;
  };

  const closeAllBlocks = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    closeTextBlock(controller);
    for (const tool of state.toolBlocks.values()) {
      if (tool.opened && !tool.closed) {
        emit(controller, 'content_block_stop', {
          type: 'content_block_stop',
          index: tool.index,
        });
        tool.closed = true;
      }
    }
  };

  const emitMessageDelta = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    const anthropicUsage = convertOpenAIUsageToAnthropic(state.usage);
    emit(controller, 'message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: mapFinishReason(state.finishReason),
        stop_sequence: null,
      },
      usage: anthropicUsage ?? { input_tokens: 0, output_tokens: 0 },
    });
  };

  const emitMessageStop = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (state.closed) return;
    emit(controller, 'message_stop', { type: 'message_stop' });
    state.closed = true;
  };

  const processOpenAIChunk = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: unknown) => {
    if (!isRecord(chunk)) throw new Error('Invalid upstream SSE event');
    if (chunk.error) throw new Error('Upstream stream error');
    if (chunk.usage && typeof chunk.usage === 'object') {
      state.usage = chunk.usage;
      state.upstreamUsage = chunk.usage;
      if (onUpstreamUsage) {
        // Fire the callback with the RAW upstream usage (OpenAI format).
        // This is the TRUE upstream usage for observability.
        try { onUpstreamUsage(chunk.usage); } catch { /* observability must never break the stream */ }
      }
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        state.finishReason = choice.finish_reason;
      }
      const delta = choice.delta || {};
      if (delta.content) {
        if (typeof delta.content === 'string') {
          if (delta.content) {
            openTextBlock(controller);
            emit(controller, 'content_block_delta', {
              type: 'content_block_delta',
              index: state.textIndex,
              delta: { type: 'text_delta', text: delta.content },
            });
          }
        } else if (Array.isArray(delta.content)) {
          for (const part of delta.content) {
            if (part?.type === 'text' && part.text) {
              openTextBlock(controller);
              emit(controller, 'content_block_delta', {
                type: 'content_block_delta',
                index: state.textIndex,
                delta: { type: 'text_delta', text: part.text },
              });
            }
          }
        }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const tcIndex = tc.index ?? 0;
          let tool = state.toolBlocks.get(tcIndex);
          if (!tool) {
            emitMessageStart(controller);
            if (state.textBlockOpened && !state.textBlockClosed) {
              closeTextBlock(controller);
            }
            tool = openToolBlock(controller, tc);
          }
          if (tc.id && tool.id !== tc.id) {
            tool.id = tc.id;
          }
          if (tc.function?.name && tool.name !== tc.function.name) {
            tool.name = tc.function.name;
          }
          if (tc.function?.arguments) {
            tool.arguments += tc.function.arguments;
            emit(controller, 'content_block_delta', {
              type: 'content_block_delta',
              index: tool.index,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            });
          }
        }
      }
    }
  };

  return convertSseStream(openAiResponseBody, (data, controller) => {
    if (data === '[DONE]') {
      closeAllBlocks(controller);
      emitMessageDelta(controller);
      emitMessageStop(controller);
      return;
    }
    let event: unknown;
    try { event = JSON.parse(data); } catch { throw new Error('Malformed upstream SSE JSON'); }
    processOpenAIChunk(controller, event);
  }, () => state.closed);
}
