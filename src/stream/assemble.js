// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Assemble a full OpenAI Chat Completions object from an upstream SSE stream.
// Used when the client asked for non-streaming output but the upstream only
// streams (FAKE_STREAM_PROTECTION mode, or Anthropic non-stream conversion of
// a streaming upstream). Nothing has been sent to the client while assembling,
// so a failure here still allows node rotation.

import { extractOpenAITextContent } from '../protocol/openai.js';
import { createSseScanner } from './guard.js';

const MAX_ASSEMBLED_BYTES = 2 * 1024 * 1024;

export async function collectOpenAIStreamObject(upstream, clientSignal) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let id = '';
  let created = Math.floor(Date.now() / 1000);
  let model = '';
  let usage = null;
  let currentBytes = 0;
  const choices = new Map();
  // Count UTF-8 bytes (not JS string.length) as each part is appended, so that
  // multi-byte text and large tool-call arguments/names/ids cannot bypass the
  // 2 MiB assembled-body memory guard.
  const countBytes = (value) => {
    if (value) currentBytes += encoder.encode(value).length;
  };

  const fail = async (message) => {
    await reader.cancel().catch(() => {});
    throw new Error(message);
  };

  const scanner = createSseScanner((data) => {
    if (!data || data === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(data);
    } catch (e) {
      throw Object.assign(new Error('Upstream returned malformed streaming data.'), { __cause: e });
    }
    if (json.id) id = json.id;
    if (json.created) created = json.created;
    if (json.model) model = json.model;
    if (json.usage) usage = json.usage;
    for (const choice of json.choices || []) {
      const idx = choice.index ?? 0;
      if (!choices.has(idx)) {
        choices.set(idx, { content: '', reasoning_content: '', toolCalls: new Map(), finish_reason: null });
      }
      const state = choices.get(idx);
      const delta = choice.delta || {};
      const text = extractOpenAITextContent(delta.content);
      if (text) {
        state.content += text;
        countBytes(text);
      }
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        state.reasoning_content += reasoning;
        countBytes(reasoning);
      }
      for (const tc of delta.tool_calls || []) {
        const tcIdx = tc.index ?? 0;
        if (!state.toolCalls.has(tcIdx)) {
          state.toolCalls.set(tcIdx, { id: '', type: 'function', function: { name: '', arguments: '' } });
        }
        const existing = state.toolCalls.get(tcIdx);
        if (tc.id !== existing.id) { existing.id = tc.id; countBytes(tc.id); }
        if (tc.type !== existing.type) existing.type = tc.type;
        if (tc.function?.name) { existing.function.name += tc.function.name; countBytes(tc.function.name); }
        if (tc.function?.arguments) { existing.function.arguments += tc.function.arguments; countBytes(tc.function.arguments); }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) state.finish_reason = choice.finish_reason;
    }
  });

  try {
    for (;;) {
      if (clientSignal?.aborted) await fail('Client aborted during stream assembly.');
      const { done, value } = await reader.read();
      if (done) break;
      scanner.push(decoder.decode(value, { stream: true }));
      if (currentBytes > MAX_ASSEMBLED_BYTES) {
        await fail('Assembled response exceeded gateway memory safety limit. Use stream:true.');
      }
    }
    scanner.flush();
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }

  if (choices.size === 0) throw new Error('Upstream returned an empty or malformed stream.');
  const states = [...choices.entries()].sort((a, b) => a[0] - b[0]);
  const hasOutput = states.some(([, s]) => Boolean(s.content) || Boolean(s.reasoning_content) || s.toolCalls.size > 0);
  if (!hasOutput) throw new Error('Upstream returned an empty streaming response.');
  const hasCompletionMarker = states.some(([, s]) => s.finish_reason !== null);
  if (!hasCompletionMarker) throw new Error('Upstream stream ended before a completion marker was received.');

  return {
    id: id || `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created,
    model,
    choices: states.map(([index, s]) => {
      const message = { role: 'assistant', content: s.content || null };
      if (s.reasoning_content) message.reasoning_content = s.reasoning_content;
      if (s.toolCalls.size) {
        message.tool_calls = [...s.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => x);
      }
      return { index, message, finish_reason: s.finish_reason || 'stop' };
    }),
    ...(usage ? { usage } : {}),
  };
}
