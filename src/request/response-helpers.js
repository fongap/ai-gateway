// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Pure response and stream helpers for the request pipeline.
//
// These functions have no closure dependency on the giant `c` context used
// by handler.js. Extracting them shrinks handler.js and makes the response
// shaping logic independently inspectable without changing behavior.

import { corsHeaders } from '../protocol/http.js';

const streamErrorEncoder = new TextEncoder();

// Build the final Response Headers for a gateway response, preserving the
// content-type and x-accel-buffering from the upstream response, layering
// extra headers on top, and finally adding the CORS headers derived from
// the request and env.
/**
 * @param {Record<string, any>} env
 * @param {Request} request
 * @param {Headers | null} [sourceHeaders]
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Headers}
 */
export function finalHeaders(env, request, sourceHeaders, extraHeaders) {
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
/**
 * @param {number} status
 * @param {unknown} data
 * @param {Record<string, any>} env
 * @param {Request} request
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Response}
 */
export function jsonResponse(status, data, env, request, extraHeaders) {
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
/**
 * @param {string} route
 * @param {string} requestId
 * @param {string} reason
 * @param {{ nextSequenceNumber?: number }} [details]
 * @returns {Uint8Array}
 */
export function streamInterruptionChunk(route, requestId, reason, { nextSequenceNumber = 0 } = {}) {
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
/**
 * @param {RuntimeNode} node
 * @param {string} logicalModel
 * @returns {string}
 */
export function upstreamModelOf(node, logicalModel) {
  return node.models[logicalModel] || logicalModel;
}
