// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// OpenAI Chat Completions SSE stream -> Anthropic Messages SSE stream converter.

import { createSseScanner } from '../stream/guard.js';
import { convertOpenAIUsageToAnthropic } from './openai-to-anthropic.js';

function mapFinishReason(reason) {
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

function encodeSseEvent(event, data) {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function createAnthropicMessageId() {
  return `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function createAnthropicStreamFromOpenAI(openAiResponseBody, options = {}) {
  const { messageId, model, inputTokens } = options;
  const finalMessageId = messageId || createAnthropicMessageId();
  const encoder = new TextEncoder();

  const state = {
    messageId: finalMessageId,
    model: model || '',
    inputTokens: Number(inputTokens ?? 0) || 0,
    messageStarted: false,
    textBlockOpened: false,
    textBlockClosed: false,
    toolBlocks: new Map(),
    blockIndex: 0,
    usage: null,
    finishReason: null,
    closed: false,
  };

  const blocks = [];

  const emit = (controller, event, data) => {
    if (state.closed) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    controller.enqueue(encoder.encode(payload));
    blocks.push({ event, data });
  };

  const emitMessageStart = (controller) => {
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

  const openTextBlock = (controller) => {
    if (state.textBlockOpened) return;
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

  const closeTextBlock = (controller) => {
    if (!state.textBlockOpened || state.textBlockClosed) return;
    state.textBlockClosed = true;
    emit(controller, 'content_block_stop', {
      type: 'content_block_stop',
      index: state.textIndex,
    });
  };

  const openToolBlock = (controller, toolCall) => {
    const index = state.blockIndex++;
    const toolState = {
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

  const closeAllBlocks = (controller) => {
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

  const emitMessageDelta = (controller) => {
    emit(controller, 'message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: mapFinishReason(state.finishReason),
        stop_sequence: null,
      },
      usage: convertOpenAIUsageToAnthropic(state.usage),
    });
  };

  const emitMessageStop = (controller) => {
    if (state.closed) return;
    emit(controller, 'message_stop', { type: 'message_stop' });
    state.closed = true;
  };

  const processOpenAIChunk = (controller, chunk) => {
    if (!chunk || typeof chunk !== 'object') return;
    if (chunk.usage && typeof chunk.usage === 'object') {
      state.usage = chunk.usage;
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

  return new ReadableStream({
    async start(controller) {
      if (!openAiResponseBody || !openAiResponseBody.getReader) {
        controller.error(new Error('OpenAI stream body is not readable'));
        return;
      }
      const reader = openAiResponseBody.getReader();
      const decoder = new TextDecoder();
      const onData = (data) => {
        if (!data || data === '[DONE]') {
          if (data === '[DONE]') {
            closeAllBlocks(controller);
            emitMessageDelta(controller);
            emitMessageStop(controller);
          }
          return;
        }
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          return;
        }
        processOpenAIChunk(controller, json);
      };
      const scanner = createSseScanner(onData);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          scanner.push(decoder.decode(value, { stream: true }));
        }
        scanner.flush();
        if (!state.closed) {
          closeAllBlocks(controller);
          if (!state.finishReason) state.finishReason = 'stop';
          emitMessageDelta(controller);
          emitMessageStop(controller);
        }
        controller.close();
      } catch (e) {
        if (!state.closed) {
          closeAllBlocks(controller);
          if (!state.finishReason) state.finishReason = 'stop';
          try { emitMessageDelta(controller); } catch { /* */ }
          try { emitMessageStop(controller); } catch { /* */ }
        }
        controller.error(e);
      }
    },
  });
}
