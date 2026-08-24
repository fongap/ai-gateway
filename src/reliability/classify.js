// SPDX-License-Identifier: MIT
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
  SERVER: 'server',
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  FIRST_EVENT: 'first_event',
  CLIENT_ABORT: 'client_abort',
};

const CLIENT_STOP_STATUSES = new Set([400, 413, 415, 422]);

// Classify a non-OK upstream response.
// Returns { kind, action: 'rotate'|'stop'|'neutral', cooldownMs, counted }.
// `counted` = transient failure that feeds the circuit breaker.
export function classifyUpstreamStatus(status, headers, env, now = Date.now()) {
  const limits = getLimits(env);
  if (status === 429) {
    const retryAfter = parseRetryAfterMs(headers, now) || limits.rateLimitCooldownMs;
    return { kind: KIND.RATE_LIMIT, action: 'rotate', cooldownMs: retryAfter, counted: false };
  }
  if (status === 401 || status === 403) {
    return { kind: KIND.AUTH, action: 'rotate', cooldownMs: limits.authFailCooldownMs, counted: false };
  }
  if (CLIENT_STOP_STATUSES.has(status)) {
    // The request itself is broken; repeating it on other nodes cannot help.
    return { kind: KIND.CLIENT, action: 'stop', cooldownMs: 0, counted: false };
  }
  if (status === 404) {
    // Usually "model not found on this node" -> mapping problem, not an outage.
    return { kind: KIND.MODEL_MISSING, action: 'rotate', cooldownMs: 5_000, counted: false };
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

export function classifyNetworkError(kindTimeout) {
  // No standalone cooldown: transient failures feed the circuit breaker,
  // which owns the open-period cooldown when the threshold trips.
  return kindTimeout
    ? { kind: KIND.TIMEOUT, action: 'rotate', cooldownMs: 0, counted: true }
    : { kind: KIND.NETWORK, action: 'rotate', cooldownMs: 0, counted: true };
}

export function classifyFirstEventFailure() {
  return { kind: KIND.FIRST_EVENT, action: 'rotate', cooldownMs: 0, counted: true };
}

export function classifyClientAbort() {
  return { kind: KIND.CLIENT_ABORT, action: 'neutral', cooldownMs: 0, counted: false };
}
