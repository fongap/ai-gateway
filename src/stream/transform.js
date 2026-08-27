// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// OpenAI Chat Completions SSE -> Anthropic Messages SSE streaming transform.
// Each upstream event is parsed exactly once via the shared SSE scanner.

import {
  mapUsageToAnthropic,
  mapFinishReason,
  normalizeAnthropicMessageId,
  gatewayThinkingSignature,
  normalizeToolArgumentsJson,
  randomId,
} from '../protocol/convert.js';
import { extractOpenAITextContent } from '../protocol/openai.js';
import { createSseScanner } from './guard.js';

export function transformOpenAIStreamToAnthropic(upstream, requestedModel, requestId, clientSignal, { onUsage } = {}) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const messageId = normalizeAnthropicMessageId(upstream.headers.get('x-request-id') || requestId);

  let finished = false;
  let nextBlockIndex = 0;
  let openBlock = null;
  let finishReason = null;
  // usage starts zeroed because message_delta must always carry a usage block;
  // usageSeen distinguishes "upstream reported it" from "never reported", so
  // observability only fires onUsage for genuinely reported usage.
  let usage = { input_tokens: 0, output_tokens: 0 };
  let usageSeen = false;
  let usageReported = false;
  let validChoiceSeen = false;
  const pendingTools = new Map();

  // Report captured usage EXACTLY ONCE per stream, when the observation
  // window closes (finalize / failStream). A client cancel never reports:
  // the window closed with the connection. Observability must never break
  // the relay, so the callback is wrapped.
  const reportUsage = () => {
    if (usageReported) return;
    usageReported = true;
    if (typeof onUsage !== 'function') return;
    try { onUsage(usageSeen ? usage : null); } catch { /* never break the stream */ }
  };

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const failStream = (message) => {
        if (finished) return;
        finished = true;
        reportUsage();
        emit('error', { type: 'error', error: { type: 'api_error', message } });
        try { controller.close(); } catch { /* already closed */ }
      };
      const closeOpenBlock = () => {
        if (!openBlock) return;
        if (openBlock.type === 'thinking') {
          emit('content_block_delta', {
            type: 'content_block_delta',
            index: openBlock.index,
            delta: { type: 'signature_delta', signature: gatewayThinkingSignature(requestedModel) },
          });
        }
        emit('content_block_stop', { type: 'content_block_stop', index: openBlock.index });
        openBlock = null;
      };
      const ensureBlock = (type) => {
        if (openBlock?.type === type) return openBlock.index;
        closeOpenBlock();
        const index = nextBlockIndex++;
        emit('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: type === 'thinking'
            ? { type: 'thinking', thinking: '', signature: '' }
            : { type: 'text', text: '' },
        });
        openBlock = { type, index };
        return index;
      };
      const absorbToolCalls = (calls) => {
        for (const tc of calls || []) {
          const idx = Number(tc.index ?? 0);
          if (!pendingTools.has(idx)) {
            pendingTools.set(idx, { id: tc.id || `toolu_${randomId()}`, name: '', arguments: '' });
          }
          const item = pendingTools.get(idx);
          if (tc.id) item.id = tc.id;
          if (tc.function?.name) item.name += tc.function.name;
          if (tc.function?.arguments) item.arguments += tc.function.arguments;
        }
      };

      const processChunk = (json) => {
        if (json?.error) {
          failStream(json.error.message || 'Upstream streaming error.');
          return true; // stop
        }
        if (json?.usage) {
          usage = mapUsageToAnthropic(json.usage);
          usageSeen = true;
        }
        const choice = json?.choices?.[0];
        if (!choice) return false;
        validChoiceSeen = true;
        const delta = choice.delta || {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning) {
          const index = ensureBlock('thinking');
          emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: reasoning } });
        }
        const text = extractOpenAITextContent(delta.content);
        if (text) {
          const index = ensureBlock('text');
          emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
        }
        if (Array.isArray(delta.tool_calls)) {
          closeOpenBlock();
          absorbToolCalls(delta.tool_calls);
        }
        if (delta.function_call) {
          closeOpenBlock();
          absorbToolCalls([{ index: 0, id: `toolu_${randomId()}`, function: delta.function_call }]);
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason;
        return false;
      };

      const finalize = () => {
        if (finished) return;
        if (nextBlockIndex === 0 && pendingTools.size === 0) {
          failStream(validChoiceSeen ? 'Upstream returned an empty streaming response.' : 'Upstream returned an empty or malformed stream.');
          return;
        }
        finished = true;
        reportUsage();
        closeOpenBlock();
        const sortedTools = [...pendingTools.entries()].sort((a, b) => a[0] - b[0]);
        for (const [, tool] of sortedTools) {
          const index = nextBlockIndex++;
          emit('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: tool.id || `toolu_${randomId()}`, name: tool.name || 'unknown_tool', input: {} },
          });
          emit('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: normalizeToolArgumentsJson(tool.arguments) },
          });
          emit('content_block_stop', { type: 'content_block_stop', index });
        }
        emit('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: mapFinishReason(finishReason, sortedTools.length > 0), stop_sequence: null },
          usage,
        });
        emit('message_stop', { type: 'message_stop' });
        controller.close();
      };

      emit('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      const scanner = createSseScanner((data) => {
        if (finished) return;
        if (data === '[DONE]') {
          // Some OpenAI-compatible providers never send an explicit
          // finish_reason chunk before [DONE] (or send only [DONE] after the
          // final content delta). A content-producing stream must still be
          // finalized into a complete Anthropic lifecycle (message_stop) rather
          // than failed — otherwise Claude Code sees a half-open stream and
          // retries. A genuinely empty stream is caught inside finalize().
          finalize();
          return;
        }
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          failStream('Upstream returned malformed streaming data.');
          return;
        }
        if (processChunk(json)) return;
      });

      try {
        for (;;) {
          if (clientSignal?.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          scanner.push(decoder.decode(value, { stream: true }));
        }
        if (!finished) scanner.flush();
        // EOF without [DONE] and without finish_reason is genuinely ambiguous:
        // after the first-event guard a mid-stream upstream death ALSO surfaces
        // as a clean close, so a missing finish_reason is the transform's only
        // signal that this was a truncation. Keep it a failure so node health
        // accounting stays correct (the client already got whichever deltas were
        // flushed before the abort). A CLIENT abort is different: the
        // observation window closed with the connection, so neither usage nor
        // missing is reported (the runtime cancels the body from here).
        if (!finished) {
          if (clientSignal?.aborted) {
            // client hang-up: window closed, nothing to report
          } else if (finishReason === null) failStream('Upstream stream ended before a completion marker was received.');
          else finalize();
        }
      } catch (e) {
        if (!clientSignal?.aborted) failStream(`Upstream stream interrupted: ${e?.message || e}`);
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
    cancel() {
      finished = true;
      reader.cancel().catch(() => {});
    },
  });

  return sseResponse(stream);
}

function sseResponse(stream) {
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
