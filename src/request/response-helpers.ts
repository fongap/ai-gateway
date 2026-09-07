// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Pure response and stream helpers for the request pipeline.
//
// These functions have no closure dependency on the giant `c` context used
// by handler.ts. Extracting them shrinks handler.ts and makes the response
// shaping logic independently inspectable without changing behavior.

import { corsHeaders } from '../protocol/http.ts';
import type { RuntimeNode } from '../types/node.ts';

const streamErrorEncoder = new TextEncoder();

// Build the final Response Headers for a gateway response, preserving the
// content-type and x-accel-buffering from the upstream response, layering
// extra headers on top, and finally adding the CORS headers derived from
// the request and env.
export function finalHeaders(env: Record<string, unknown>, request: Request, sourceHeaders?: Headers | null, extraHeaders?: Record<string, string>): Headers {
  const headers = new Headers();
  if (sourceHeaders) {
    const contentType = sourceHeaders.get('content-type');
    if (contentType) headers.set('content-type', contentType);
    const buffering = sourceHeaders.get('x-accel-buffering');
    if (buffering) headers.set('x-accel-buffering', buffering);
  }
  for (const [key, value] of Object.entries(extraHeaders || {})) headers.set(key, value);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) headers.set(key, value);
  return headers;
}

// Build a JSON Response with no-store caching, optional extra headers, and
// the gateway's standard CORS headers.
export function jsonResponse(status: number, data: unknown, env: Record<string, unknown>, request: Request, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      ...(extraHeaders || {}),
      ...corsHeaders(request, env),
    },
  });
}

// Build the SSE-encoded error chunk that the gateway injects into a stream
// when a transparent failover is no longer safe. The shape is route-specific:
// Responses uses event: error + type/error, Anthropic uses event: error +
// type/error nested under .error, and OpenAI Chat uses a plain data: payload.
export function streamInterruptionChunk(route: string, requestId: string, reason: string | null, { nextSequenceNumber = 0 }: { nextSequenceNumber?: number } = {}): Uint8Array {
  const message = `Gateway upstream stream interrupted (${reason || 'unknown'}).`;
  let event;
  if (route === 'openai_responses') {
    event = `event: error\ndata: ${JSON.stringify({ type: 'error', code: 'stream_interrupted', message, param: null, sequence_number: nextSequenceNumber })}\n\n`;
  } else if (route === 'anthropic_messages') {
    event = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`;
  } else {
    event = `data: ${JSON.stringify({ error: { message, type: 'api_error', code: 'stream_interrupted' } })}\n\n`;
  }
  return streamErrorEncoder.encode(event);
}

// Resolve the upstream model name for a given node + logical model. The
// node's `models` map translates the client-facing logical name to the
// provider-specific name; the original logical name is the fallback.
export function upstreamModelOf(node: RuntimeNode, logicalModel: string): string {
  return node.models[logicalModel] || logicalModel;
}
