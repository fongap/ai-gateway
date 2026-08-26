// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// OpenAI Chat Completions surface: request validation, model-field
// normalization, and completion->SSE synthesis for OpenAI-compatible clients.

import { corsHeaders } from './http.js';

export function validateOpenAIChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object.';
  if (!body.model || typeof body.model !== 'string' || !body.model.trim()) return 'model is required and must be a non-empty string.';
  if (!Array.isArray(body.messages)) return 'messages is required and must be an array.';
  return null;
}

export function extractOpenAITextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (typeof part === 'string') out += part;
    else if (part?.type === 'text' || part?.type === 'output_text') out += part.text || '';
  }
  return out;
}

export function isOpenAIStreamingResponse(response) {
  return (response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream');
}

// Convert a full OpenAI completion object into a well-formed SSE stream
// (delta chunks + finish chunk + [DONE]) for clients that requested streaming
// but received JSON from the upstream. Pure synthesis: it does not wrap an
// upstream stream, so it can be called freely from the success path.
export function synthesizeSseFromCompletion(data, env, request, extraHeaders) {
  const encoder = new TextEncoder();
  const choices = Array.isArray(data?.choices) ? data.choices : [];
  const base = {
    id: data?.id || `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion.chunk',
    created: data?.created || Math.floor(Date.now() / 1000),
    model: data?.model,
  };
  const stream = new ReadableStream({
    start(controller) {
      const emit = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      for (const choice of choices) {
        const msg = choice.message || {};
        const delta = { role: msg.role || 'assistant' };
        if (msg.content) delta.content = msg.content;
        if (msg.reasoning_content) delta.reasoning_content = msg.reasoning_content;
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) delta.tool_calls = msg.tool_calls;
        emit({ ...base, choices: [{ index: choice.index ?? 0, delta, finish_reason: null }] });
      }
      for (const choice of choices) {
        const finish = { index: choice.index ?? 0, delta: {}, finish_reason: choice.finish_reason || 'stop' };
        emit({ ...base, choices: [finish], ...(data.usage ? { usage: data.usage } : {}) });
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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
      ...corsHeaders(request, env),
    },
  });
}

