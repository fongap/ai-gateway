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
import {
  UPSTREAM_PROCESSING_ERROR,
  upstreamProcessingErrorCode,
} from '../transport/processing-error.ts';

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
  NON_JSON_BODY: 'upstream_200_non_json_body',
  EMPTY_200: 'upstream_200_no_meaningful_output',
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
  explicitRetryAfter?: boolean,
};

const CLIENT_STOP_STATUSES = new Set([400, 413, 415, 422]);

function rateLimitClassification(headers: Headers, env: Record<string, unknown>, now: number): FailureClassification {
  const limits = getLimits(env);
  const retryAfterMs = parseRetryAfterMs(headers, now);
  return {
    kind: KIND.RATE_LIMIT,
    action: 'rotate',
    cooldownMs: retryAfterMs || limits.rateLimitCooldownMs,
    retryAfterMs,
    counted: false,
    explicitRetryAfter: retryAfterMs > 0,
  };
}

function looksLikeProviderRateLimit(body: unknown): boolean {
  const text = String(body || '').toLowerCase();
  if (!text) return false;
  if (/\b(?:itpm|tpm|rpm)\b/.test(text)) return true;
  if (/\b(?:input\s+)?tokens?\s+per\s+minute\b/.test(text)) return true;
  if (/\brequests?\s+per\s+minute\b/.test(text)) return true;
  if (/\brate[ _-]?limit(?:ed|ing)?\b/.test(text)) return true;
  return false;
}

export function classifyUpstreamStatus(status: number, headers: Headers, env: Record<string, unknown>, now: number = Date.now(), body: unknown = ''): FailureClassification {
  const limits = getLimits(env);
  if (status === 429) return rateLimitClassification(headers, env, now);
  if (status === 413 && looksLikeProviderRateLimit(body)) return rateLimitClassification(headers, env, now);
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
  if (status === 408 || status === 425) {
    return { kind: KIND.SERVER, action: 'rotate', cooldownMs: 0, counted: true };
  }
  if (status === 409) {
    return { kind: KIND.SERVER, action: 'stop', cooldownMs: 0, counted: false };
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

export function classifyPostHeadersFailure(error: unknown): FailureClassification {
  const code = upstreamProcessingErrorCode(error);
  if (code === UPSTREAM_PROCESSING_ERROR.DEADLINE) return classifyFirstEventFailure();
  if (code === UPSTREAM_PROCESSING_ERROR.MALFORMED || code === UPSTREAM_PROCESSING_ERROR.TOO_LARGE) return classifyNonJsonBody();
  if (code === UPSTREAM_PROCESSING_ERROR.TRUNCATED) return classifyStreamInterrupted();
  if (code === UPSTREAM_PROCESSING_ERROR.EMPTY) return classifyEmptyResponse();
  if (code === UPSTREAM_PROCESSING_ERROR.TERMINAL) {
    return { kind: KIND.SERVER, action: 'rotate', cooldownMs: 0, counted: true };
  }
  if (error instanceof SyntaxError) return classifyNonJsonBody();
  return classifyFirstEventFailure();
}

export function classifyClientAbort(): FailureClassification {
  return { kind: KIND.CLIENT_ABORT, action: 'neutral', cooldownMs: 0, counted: false };
}

export function classifyPreDispatchInvalidBaseUrl(): FailureClassification {
  return { kind: KIND.INVALID_BASE_URL, action: 'rotate', cooldownMs: 0, counted: false };
}

export function classifyNonJsonBody(): FailureClassification {
  return { kind: KIND.NON_JSON_BODY, action: 'rotate', cooldownMs: 5_000, counted: true };
}

export function classifyEmptyResponse(): FailureClassification {
  return { kind: KIND.EMPTY_200, action: 'rotate', cooldownMs: 5_000, counted: true };
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
