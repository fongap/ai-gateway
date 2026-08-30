// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Single source of truth for every timeout / cooldown value.
// Do not hardcode timeout defaults anywhere else.

import { readEnv, clampInt } from './env.js';

const LIMITS = {
  UPSTREAM_HEADERS_TIMEOUT_MS: { min: 5_000, max: 600_000, def: 60_000 },
  FIRST_EVENT_TIMEOUT_MS: { min: 5_000, max: 600_000, def: 120_000 },
  STREAM_IDLE_TIMEOUT_MS: { min: 10_000, max: 600_000, def: 240_000 },
  RATE_LIMIT_COOLDOWN_MS: { min: 1_000, max: 600_000, def: 60_000 },
  AUTH_FAIL_COOLDOWN_MS: { min: 60_000, max: 7 * 86_400_000, def: 3_600_000 },
  MAX_BODY_BYTES: { min: 1024, max: 100 * 1024 * 1024, def: 20 * 1024 * 1024 },
  // Whole-request failover budget: the total wall-clock time the gateway may
  // spend rotating across nodes for ONE client request. Prevents the worst
  // case of headersTimeout(60s) * maxAttempts(5) ≈ 300s per Agent call.
  FAILOVER_BUDGET_MS: { min: 1_000, max: 900_000, def: 240_000 },
  // Reactive hedge (Envoy-style per-try hedge): when the first attempt has
  // not committed a response within this window, ONE twin attempt is launched
  // against the next-best candidate and the two race. 0 disables hedging.
  HEDGE_DELAY_MS: { min: 0, max: 600_000, def: 4_000 },
};

// Retry-After is always clamped into this window so a hostile or broken
// upstream cannot park a node for hours via one header.
const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 600_000;

// Floor for one attempt's response-header wait. Healthy upstreams return
// headers in seconds; the floor only matters when the fair share of a large
// remaining budget would undercut a viable slow upstream.
export const MIN_ATTEMPT_HEADERS_MS = 20_000;
export const MIN_ATTEMPT_FIRST_EVENT_MS = 5_000;

// One dispatch gets one wall-clock slice. Response headers and the first SSE
// event both consume this SAME slice; callers turn it into an absolute
// deadline. Without an attempt deadline the two serial phases could each take
// a separately calculated fair share and still starve later candidates.
export function attemptBudgetSliceMs(remainingBudgetMs, remainingAttempts) {
  const attempts = Math.max(1, Math.trunc(remainingAttempts) || 1);
  return Math.max(1, Math.floor(Math.max(0, remainingBudgetMs) / attempts));
}

function fairShareTimeoutMs(configuredTimeoutMs, remainingBudgetMs, remainingAttempts, floorMs) {
  const attempts = Math.max(1, Math.trunc(remainingAttempts) || 1);
  const budget = Math.max(0, remainingBudgetMs);
  const share = Math.floor(budget / attempts);
  const wait = Math.min(
    configuredTimeoutMs,
    budget,
    Math.max(floorMs, share),
  );
  return Math.max(1, wait);
}

// Per-attempt response-header wait. The whole-request failover budget is
// divided evenly across the attempts that may still be needed, so the first
// node cannot consume UPSTREAM_HEADERS_TIMEOUT_MS in full and starve every
// later candidate (with 120s headers / 180s budget the second node used to be
// left ~60s, and a two-timeout request died at 504 with only half its budget
// spent on real candidates). The result is still capped by
// UPSTREAM_HEADERS_TIMEOUT_MS and by the remaining budget itself — a single
// remaining attempt keeps the old behavior exactly (share = remaining).
export function attemptHeadersTimeoutMs(headersTimeoutMs, remainingBudgetMs, remainingAttempts) {
  return fairShareTimeoutMs(
    headersTimeoutMs, remainingBudgetMs, remainingAttempts, MIN_ATTEMPT_HEADERS_MS,
  );
}

// The first-event guard shares the same whole-request budget as the headers
// wait.  Split it across the candidates that can still be attempted too;
// otherwise an upstream that returns HTTP 200/SSE headers and then stays
// silent can consume FIRST_EVENT_TIMEOUT_MS in full and recreate the exact
// starvation that fair header waits prevent.
export function attemptFirstEventTimeoutMs(firstEventTimeoutMs, remainingBudgetMs, remainingAttempts) {
  return fairShareTimeoutMs(
    firstEventTimeoutMs, remainingBudgetMs, remainingAttempts, MIN_ATTEMPT_FIRST_EVENT_MS,
  );
}

const cache = new WeakMap();

export function getLimits(env) {
  let cached = cache.get(env);
  if (cached) return cached;
  cached = {
    headersTimeoutMs: clampInt(readEnv(env, 'UPSTREAM_HEADERS_TIMEOUT_MS'), LIMITS.UPSTREAM_HEADERS_TIMEOUT_MS.min, LIMITS.UPSTREAM_HEADERS_TIMEOUT_MS.max, LIMITS.UPSTREAM_HEADERS_TIMEOUT_MS.def),
    firstEventTimeoutMs: clampInt(readEnv(env, 'FIRST_EVENT_TIMEOUT_MS'), LIMITS.FIRST_EVENT_TIMEOUT_MS.min, LIMITS.FIRST_EVENT_TIMEOUT_MS.max, LIMITS.FIRST_EVENT_TIMEOUT_MS.def),
    streamIdleTimeoutMs: clampInt(readEnv(env, 'STREAM_IDLE_TIMEOUT_MS'), LIMITS.STREAM_IDLE_TIMEOUT_MS.min, LIMITS.STREAM_IDLE_TIMEOUT_MS.max, LIMITS.STREAM_IDLE_TIMEOUT_MS.def),
    rateLimitCooldownMs: clampInt(readEnv(env, 'RATE_LIMIT_COOLDOWN_MS'), LIMITS.RATE_LIMIT_COOLDOWN_MS.min, LIMITS.RATE_LIMIT_COOLDOWN_MS.max, LIMITS.RATE_LIMIT_COOLDOWN_MS.def),
    authFailCooldownMs: clampInt(readEnv(env, 'AUTH_FAIL_COOLDOWN_MS'), LIMITS.AUTH_FAIL_COOLDOWN_MS.min, LIMITS.AUTH_FAIL_COOLDOWN_MS.max, LIMITS.AUTH_FAIL_COOLDOWN_MS.def),
    maxBodyBytes: clampInt(readEnv(env, 'MAX_BODY_BYTES'), LIMITS.MAX_BODY_BYTES.min, LIMITS.MAX_BODY_BYTES.max, LIMITS.MAX_BODY_BYTES.def),
    failoverBudgetMs: clampInt(readEnv(env, 'FAILOVER_BUDGET_MS'), LIMITS.FAILOVER_BUDGET_MS.min, LIMITS.FAILOVER_BUDGET_MS.max, LIMITS.FAILOVER_BUDGET_MS.def),
    hedgeDelayMs: clampInt(readEnv(env, 'HEDGE_DELAY_MS'), LIMITS.HEDGE_DELAY_MS.min, LIMITS.HEDGE_DELAY_MS.max, LIMITS.HEDGE_DELAY_MS.def),
  };
  cache.set(env, cached);
  return cached;
}

// Parse a Retry-After header. Supports delay-seconds and HTTP-date forms.
// Returns milliseconds clamped to [RETRY_AFTER_MIN_MS, RETRY_AFTER_MAX_MS], or 0 when absent/invalid.
export function parseRetryAfterMs(headers, now = Date.now()) {
  const value = headers?.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(Math.round(seconds * 1000), RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(dateMs - now, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
  }
  return 0;
}
