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

// `KIND` is the single source of truth for every failure-kind
// string that appears on the request hot path (LoopState.failureKinds,
// AttemptOutcome.kind, terminalStatus dispatch, Tier1 mapping). It is
// exported so consumers (e.g. errors.ts) can compare against the canonical
// values without re-typing the literal.
export const KIND = {
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
  // --- pre-dispatch and intra-request kinds ---------------
  // A pre-dispatch denial by a distributed rate-limiter binding: the request
  // never reached an upstream, so it must NOT consume any failover budget.
  RATE_LIMIT_GLOBAL: 'rate_limit_global',
  // A structurally broken node config (e.g. an unparseable base_url): the
  // request never reached an upstream, so it must NOT consume any budget.
  INVALID_BASE_URL: 'invalid_base_url',
  // A streaming response was interrupted mid-generation (TTL expiry, peer
  // close, missing completion marker). Counted=true so the circuit breaker
  // sees it; Tier 1 gets a 60s cooldown via applyHealthPenalty.
  STREAM_INTERRUPTED: 'stream_interrupted',
  // An HTTP 200 response whose body was not parseable as the expected JSON
  // shape. Neutral end (the upstream WAS contacted), no circuit penalty.
  NON_JSON_BODY: 'upstream_200_non_json_body',
  // A hedge twin (or the primary) that lost the race and was aborted after
  // its peer committed. Neutral — no rotation, no penalty, no budget charge.
  CANCELLED_AFTER_PEER_COMMIT: 'cancelled_after_peer_commit',
  // A hedge twin / primary that errored in an unexpected way (the catch-all
  // around attemptNode in hedge.ts). Rotate to give the next node a chance.
  UNKNOWN: 'unknown',
} as const;

export type FailureKind = typeof KIND[keyof typeof KIND];

// Classification result shared by every classify* function. Extra fields are
// optional because only some paths carry them (retryAfterMs for 429,
// modelScoped for 404 model-missing).
export type FailureClassification = {
  kind: FailureKind,
  action: 'rotate' | 'stop' | 'neutral',
  cooldownMs: number,
  counted: boolean,
  retryAfterMs?: number,
  modelScoped?: boolean,
};

const CLIENT_STOP_STATUSES = new Set([400, 413, 415, 422]);

// Classify a non-OK upstream response.
// Returns { kind, action: 'rotate'|'stop'|'neutral', cooldownMs, counted }.
// `counted` = transient failure that feeds the circuit breaker.
// `body` (optional 5th arg) carries the upstream error text, used to tell a
// "model not found" 404 apart from an "endpoint not found" 404.
export function classifyUpstreamStatus(status: number, headers: Headers, env: Record<string, unknown>, now: number = Date.now(), body: unknown = ''): FailureClassification {
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
function looksLikeModelMissing(body: unknown): boolean {
  const text = String(body || '').toLowerCase();
  if (!text.includes('model')) return false;
  return /(not found|does not exist|unknown|no such|not supported|invalid model)/.test(text);
}

export function classifyNetworkError(kindHeadersTimeout: boolean): FailureClassification {
  // No standalone cooldown: transient failures feed the circuit breaker,
  // which owns the open-period cooldown when the threshold trips.
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

// Pre-dispatch and intra-request classification helpers.
// These cover failures that never produced an HTTP status (the upstream was
// never contacted) or that happen mid-stream. They are kept here so the
// entire `kind` vocabulary lives in one place: `KIND` is the single source of
// truth, every consumer imports from this module, and the type system catches
// drift.

// Distributed rate-limiter binding denied the request before dispatch.
// Rotate (so a same-tier healthy node gets a chance on the same logical
// attempt), but do NOT charge the failover budget — the request never
// touched a provider, so consuming max_attempts / budget_ms would let a
// stream of CF-denied keys starve healthy candidates and every fallback tier
// without ever contacting a provider.
export function classifyPreDispatchRateLimit(): FailureClassification {
  return { kind: KIND.RATE_LIMIT_GLOBAL, action: 'rotate', cooldownMs: 0, counted: false };
}

// The node's base_url is structurally invalid (unparseable URL, wrong
// scheme, etc.). Rotate, do NOT charge the budget, do NOT feed the circuit
// (a misconfigured node is an operator problem, not a provider health
// issue).
export function classifyPreDispatchInvalidBaseUrl(): FailureClassification {
  return { kind: KIND.INVALID_BASE_URL, action: 'rotate', cooldownMs: 0, counted: false };
}

// The upstream returned HTTP 200 with a body that could not be parsed as
// the expected JSON shape. Neutral end (the upstream WAS contacted, so do
// not roll back the RPM slot), no circuit penalty, no cooldown.
export function classifyNonJsonBody(): FailureClassification {
  return { kind: KIND.NON_JSON_BODY, action: 'neutral', cooldownMs: 0, counted: false };
}

// The stream was interrupted mid-generation (TTL expiry, peer close, missing
// completion marker). Rotate so a different node is tried on the next
// attempt; counted=true so the circuit breaker sees it; 60s cooldown on
// Tier 2/3 (matches the rate-limit cooldown so repeat offenders fall out
// of the candidate ordering without permanent discard).
export function classifyStreamInterrupted(): FailureClassification {
  return { kind: KIND.STREAM_INTERRUPTED, action: 'rotate', cooldownMs: 60_000, counted: true };
}

// A hedge twin (or the primary) lost the race and was aborted because its
// peer committed a response. Neutral — no rotation, no penalty, no budget
// charge. The winner is the one that decides the request outcome; the loser
// is just bookkeeping.
export function classifyHedgeRaceLoss(): FailureClassification {
  return { kind: KIND.CANCELLED_AFTER_PEER_COMMIT, action: 'neutral', cooldownMs: 0, counted: false };
}

// The hedge promise rejected in an unexpected way (network blip, abort
// storm, etc.). Rotate to give the next node a chance; the regular upstream
// failure path will re-classify the real reason if there is one.
export function classifyHedgeUnknown(): FailureClassification {
  return { kind: KIND.UNKNOWN, action: 'rotate', cooldownMs: 0, counted: false };
}
