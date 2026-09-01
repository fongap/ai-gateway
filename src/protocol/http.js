// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// HTTP boundary helpers: CORS, error responses, upstream headers, URL
// building, timing-safe auth, bounded body reads.

import { readEnv } from '../config/env.js';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function corsHeaders(request, env) {
  const allowedOrigin = readEnv(env, 'ALLOWED_ORIGIN');
  // Default: CORS disabled. Browser access requires explicit ALLOWED_ORIGIN.
  if (!allowedOrigin) return { ...SECURITY_HEADERS };
  const origin = normalizeAllowedOrigin(allowedOrigin);
  if (origin === null) return { ...SECURITY_HEADERS };
  const requested = String(request.headers.get('Access-Control-Request-Headers') || '')
    .split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
  const allowedRequestHeaders = new Set([
    'authorization', 'x-api-key', 'content-type', 'accept', 'idempotency-key',
    'anthropic-version', 'anthropic-beta',
  ]);
  const accepted = requested.filter((v) => allowedRequestHeaders.has(v));
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': accepted.length > 0 ? accepted.join(', ') : 'Authorization,X-Api-Key,Content-Type,Accept',
    'Access-Control-Max-Age': '86400',
    ...SECURITY_HEADERS,
  };
  if (origin !== '*') headers.Vary = 'Origin';
  return headers;
}

function normalizeAllowedOrigin(value) {
  if (value === '*') return '*';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') return null;
    if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function jsonError(request, env, status, message, details, requestId, extraHeaders) {
  return new Response(JSON.stringify({ error: { message, ...(details ? { details } : {}) } }), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'x-request-id': requestId || '',
      ...corsHeaders(request, env),
      ...(extraHeaders || {}),
    },
  });
}

export function htmlResponse(content, init?) {
  return new Response(content, {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'text/html;charset=UTF-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    },
    ...init?.headers,
  });
}

// Strict upstream header construction lives in src/transport/: the protocol
// owns its auth header shape (OpenAI -> Authorization Bearer, Anthropic ->
// x-api-key). Client auth material is never forwarded for either protocol.

// Join an upstream API path onto a configured base_url.
// If base_url already ends with /v1, a leading /v1 on the path is stripped
// so "https://host/v1" + "/v1/chat/completions" does not double the prefix.
export function buildTargetUrl(baseUrl, upstreamPath) {
  const base = new URL(baseUrl);
  let path = upstreamPath || '/';
  const basePath = base.pathname.replace(/\/+$/, '').toLowerCase();
  if ((basePath === '/v1' || basePath.endsWith('/v1')) && /^\/v1(?:\/|$)/i.test(path)) {
    path = path.replace(/^\/v1/i, '') || '/';
  }
  base.pathname = joinPath(base.pathname, path);
  base.search = '';
  return base.toString();
}

function joinPath(left, right) {
  const a = String(left || '').replace(/\/+$/, '');
  const b = String(right || '').replace(/^\/+/, '');
  return `/${[a.replace(/^\/+/, ''), b].filter(Boolean).join('/')}`;
}

export class BodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeds limit.');
    this.name = 'BodyTooLargeError';
  }
}

export async function readBodyTextWithLimit(request, maxBytes) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function safeReadErrorBody(response, maxBytes = 4096) {
  try {
    const ct = (response.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/event-stream')) return '[streaming body skipped]';
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks = [];
    let total = 0;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.byteLength;
      if (slice.byteLength < value.byteLength) break;
    }
    await reader.cancel().catch(() => {});
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
  } catch {
    return '';
  }
}

export function trimDiagnostic(text, limit = 600) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, limit);
}

// Terminal-error intent header: tells SDKs (Codex / Claude) NOT to auto-retry a
// request the gateway already resolved — the gateway has internally rotated
// across nodes, so a client-side blind retry risks re-executing a tool call.
// Rate-limit (429) and capacity (503) responses stay retryable via Retry-After.
export function shouldNotRetryHeaders(status) {
  if (status === 429 || status === 503) return {};
  return { 'x-should-retry': 'false' };
}
