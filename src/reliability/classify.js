// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Upstream error classification. One function decides, per failed attempt,
// whether the request should rotate to another node in the same tier, stop
// entirely, or end neutrally — and which node-local cooldown applies.
//
// Rules of scope: every failure here is NODE-local. Never punish a provider,
// tier, or the whole gateway for one node's 429/401.

import { parseRetryAfterMs, getLimits } from '../config/timeouts.js';

const KIND = {
  RATE_LIMIT: 'rate_limit',
  AUTH: 'auth',
  CLIENT: 'client',
  MODEL_MISSING: 'model_missing',
  ENDPOINT_NOT_FOUND: 'endpoint_not_found',
  SERVER: 'server',
  NETWORK: 'network',
  // Waiting for HTTP response headers timed out: no HTTP status was ever
  // received (status=0 in attempt records).
  HEADERS_TIMEOUT: 'headers_timeout',
  // HTTP 200 headers were received but no valid SSE event arrived in time
  // (status=200 in attempt records; the wait after headers is the TTFT wait).
  FIRST_EVENT_TIMEOUT: 'first_event_timeout',
  CLIENT_ABORT: 'client_abort',
};

const CLIENT_STOP_STATUSES = new Set([400, 413, 415, 422]);

// Classify a non-OK upstream response.
// Returns { kind, action: 'rotate'|'stop'|'neutral', cooldownMs, counted }.
// `counted` = transient failure that feeds the circuit breaker.
// `body` (optional 5th arg) carries the upstream error text, used to tell a
// "model not found" 404 apart from an "endpoint not found" 404.
export function classifyUpstreamStatus(status, headers, env, now = Date.now(), body = '') {
  const limits = getLimits(env);
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(headers, now);
    // Tier 2/3 retain the configured fixed fallback through cooldownMs. Tier 1
    // reads retryAfterMs separately so an absent header can drive its own
    // repeated-429 exponential backoff instead of looking explicit.
    return {
      kind: KIND.RATE_LIMIT,
      action: 'rotate',
      cooldownMs: retryAfterMs || limits.rateLimitCooldownMs,
      retryAfterMs,
      counted: false,
    };
  }
  if (status === 401 || status === 403) {
    return { kind: KIND.AUTH, action: 'rotate', cooldownMs: limits.authFailCooldownMs, counted: false };
  }
  if (CLIENT_STOP_STATUSES.has(status)) {
    // The request itself is broken; repeating it on other nodes cannot help.
    return { kind: KIND.CLIENT, action: 'stop', cooldownMs: 0, counted: false };
  }
  if (status === 404) {
    // A 404 is either "model not found on this node" (a model-mapping problem:
    // cool only the (node, model) pair) or "endpoint not found" (a node config
    // problem: wrong base_url/path — cool the whole node briefly so a broken
    // endpoint is not hammered). The error body disambiguates: a model-shaped
    // message means the former; anything else is treated as an endpoint 404.
    if (looksLikeModelMissing(body)) {
      return { kind: KIND.MODEL_MISSING, action: 'rotate', cooldownMs: 5_000, counted: false, modelScoped: true };
    }
    return { kind: KIND.ENDPOINT_NOT_FOUND, action: 'rotate', cooldownMs: 5_000, counted: false };
  }
  if (status === 408 || status === 425 || status === 409) {
    return { kind: KIND.SERVER, action: 'rotate', cooldownMs: 0, counted: true };
  }
  if (status >= 500) {
    return { kind: KIND.SERVER, action: 'rotate', cooldownMs: 0, counted: true };
  }
  // Other 4xx: gateway-generated semantics vary; treat as client-visible stop.
  return { kind: KIND.CLIENT, action: 'stop', cooldownMs: 0, counted: false };
}

// Heuristic: does a 404 error body indicate a missing/unknown MODEL rather
// than a missing endpoint? Model-not-found errors mention "model" alongside
// not-found / unknown / does-not-exist language; a bare endpoint 404 usually
// says only "not found" (or nothing). Conservative: only classify as a model
// problem when the body strongly implies one.
function looksLikeModelMissing(body) {
  const text = String(body || '').toLowerCase();
  if (!text.includes('model')) return false;
  return /(not found|does not exist|unknown|no such|not supported|invalid model)/.test(text);
}

export function classifyNetworkError(kindHeadersTimeout) {
  // No standalone cooldown: transient failures feed the circuit breaker,
  // which owns the open-period cooldown when the threshold trips.
  return kindHeadersTimeout
    ? { kind: KIND.HEADERS_TIMEOUT, action: 'rotate', cooldownMs: 0, counted: true }
    : { kind: KIND.NETWORK, action: 'rotate', cooldownMs: 0, counted: true };
}

export function classifyFirstEventFailure() {
  return { kind: KIND.FIRST_EVENT_TIMEOUT, action: 'rotate', cooldownMs: 0, counted: true };
}

export function classifyClientAbort() {
  return { kind: KIND.CLIENT_ABORT, action: 'neutral', cooldownMs: 0, counted: false };
}
