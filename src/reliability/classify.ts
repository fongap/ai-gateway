// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Upstream error classification. One function decides, per failed attempt,
// whether the request should rotate to another node in the same tier, stop
// entirely, or end neutrally — and which node-local cooldown applies.
//
// Rules of scope: every failure here is NODE-local. Never punish a provider,
// tier, or the whole gateway for one node's 429/401.

import { parseRetryAfterMs, getLimits } from '../config/timeouts.ts';

export const KIND = {
  RATE_LIMIT: 'rate_limit',
  AUTH: 'auth',
  CLIENT: 'client',
  MODEL_MISSING: 'model_missing',
  ENDPOINT_NOT_FOUND: 'endpoint_not_found',
  SERVER: 'server',
  NETWORK: 'network',
  HEADERS_TIMEOUT: 'headers_timeout',
  FIRST_EVENT_TIMEOUT: 'first_event_timeout',
  CLIENT_ABORT: 'client_abort',
  RATE_LIMIT_GLOBAL: 'rate_limit_global',
  INVALID_BASE_URL: 'invalid_base_url',
  STREAM_INTERRUPTED: 'stream_interrupted',
  // HTTP 200 but the body is not the expected protocol payload. This is an
  // upstream/proxy protocol failure, not a success and not a neutral end: a
  // broken WAF/HTML/garbage responder must fall out of routing temporarily.
  NON_JSON_BODY: 'upstream_200_non_json_body',
  CANCELLED_AFTER_PEER_COMMIT: 'cancelled_after_peer_commit',
  UNKNOWN: 'unknown',
} as const;

export type FailureKind = typeof KIND[keyof typeof KIND];

export type FailureClassification = {
  kind: FailureKind,
  action: 'rotate' | 'stop' | 'neutral',
  cooldownMs: number,
  counted: boolean,
  retryAfterMs?: number,
  modelScoped?: boolean,
};

const CLIENT_STOP_STATUSES = new Set([400, 413, 415, 422]);

export function classifyUpstreamStatus(status: number, headers: Headers, env: Record<string, unknown>, now: number = Date.now(), body: unknown = ''): FailureClassification {
  const limits = getLimits(env);
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(headers, now);
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
    return { kind: KIND.CLIENT, action: 'stop', cooldownMs: 0, counted: false };
  }
  if (status === 404) {
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
  return { kind: KIND.CLIENT, action: 'stop', cooldownMs: 0, counted: false };
}

function looksLikeModelMissing(body: unknown): boolean {
  const text = String(body || '').toLowerCase();
  if (!text.includes('model')) return false;
  return /(not found|does not exist|unknown|no such|not supported|invalid model)/.test(text);
}

export function classifyNetworkError(kindHeadersTimeout: boolean): FailureClassification {
  return kindHeadersTimeout
    ? { kind: KIND.HEADERS_TIMEOUT, action: 'rotate', cooldownMs: 0, counted: true }
    : { kind: KIND.NETWORK, action: 'rotate', cooldownMs: 0, counted: true };
}

export function classifyFirstEventFailure(): FailureClassification {
  return { kind: KIND.FIRST_EVENT_TIMEOUT, action: 'rotate', cooldownMs: 0, counted: true };
}

export function classifyClientAbort(): FailureClassification {
  return { kind: KIND.CLIENT_ABORT, action: 'neutral', cooldownMs: 0, counted: false };
}

export function classifyPreDispatchRateLimit(): FailureClassification {
  return { kind: KIND.RATE_LIMIT_GLOBAL, action: 'rotate', cooldownMs: 0, counted: false };
}

export function classifyPreDispatchInvalidBaseUrl(): FailureClassification {
  return { kind: KIND.INVALID_BASE_URL, action: 'rotate', cooldownMs: 0, counted: false };
}

// A 200 response with a body that is not the expected JSON shape means the
// upstream path is broken at the protocol boundary (common examples: HTML WAF
// pages and proxy error documents). Rotate immediately, apply a short cooldown,
// and count it so repeated offenders naturally reach the existing circuit
// breaker instead of being selected forever as a neutral node.
export function classifyNonJsonBody(): FailureClassification {
  return { kind: KIND.NON_JSON_BODY, action: 'rotate', cooldownMs: 5_000, counted: true };
}

export function classifyStreamInterrupted(): FailureClassification {
  return { kind: KIND.STREAM_INTERRUPTED, action: 'rotate', cooldownMs: 60_000, counted: true };
}

export function classifyHedgeRaceLoss(): FailureClassification {
  return { kind: KIND.CANCELLED_AFTER_PEER_COMMIT, action: 'neutral', cooldownMs: 0, counted: false };
}

export function classifyHedgeUnknown(): FailureClassification {
  return { kind: KIND.UNKNOWN, action: 'rotate', cooldownMs: 0, counted: false };
}
