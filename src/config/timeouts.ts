// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Single source of truth for every timeout / cooldown value.
// Do not hardcode timeout defaults anywhere else.

import { readEnv, clampInt } from './env.ts';
import { RUNTIME_TUNABLES } from './runtime-vars.ts';

// Derived from the single source of truth in runtime-vars.ts. Do not add
// tunable definitions here — add them there so the deployment bridge, docs
// and example configs stay in sync automatically.
const LIMITS: Record<string, { min: number, max: number, def: number }> = Object.fromEntries(
  RUNTIME_TUNABLES.map((v) => [v.name, { min: v.min, max: v.max, def: v.def }]),
);

// Retry-After is always clamped into this window so a hostile or broken
// upstream cannot park a node for hours via one header.
const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 600_000;

// Floors for phase-local waits. These are not request-wide admission limits;
// the absolute attempt deadline and remaining request budget still win.
export const MIN_ATTEMPT_HEADERS_MS = 20_000;
export const MIN_ATTEMPT_FIRST_EVENT_MS = 5_000;

// Reserve a small escape window for each later logical attempt instead of
// dividing the whole request budget evenly up front. Five seconds is enough
// for a healthy alternate to return headers / an early event or fail fast,
// while allowing the preferred candidate to use its configured work window.
// When the total budget is too tight to reserve 5s per later attempt, the
// allocator automatically falls back to an equal share.
export const MIN_FAILOVER_RESERVE_MS = 5_000;

export type Limits = {
  headersTimeoutMs: number,
  firstEventTimeoutMs: number,
  streamIdleTimeoutMs: number,
  rateLimitCooldownMs: number,
  authFailCooldownMs: number,
  maxBodyBytes: number,
  failoverBudgetMs: number,
  hedgeDelayMs: number,
  maxHedgesPerRequest: number,
  gatewayKeyRpm: number,
}

// Allocate one logical attempt's absolute wall-clock window.
//
// Old behavior divided the remaining budget evenly by every candidate that
// might still be tried. With the default 60s / 5-attempt policy that gave the
// preferred candidate only ~12s total for BOTH response headers and the first
// meaningful event, so a healthy coding/reasoning model could be killed well
// before its configured FIRST_EVENT_TIMEOUT_MS.
//
// The reserve-aware allocator gives the current candidate as much of its
// configured work window as possible, while keeping a minimum escape reserve
// for each later candidate. If the request budget is already tight, reserve
// per later candidate shrinks to the equal-share value, so the allocator never
// starves the tail. `attemptCeilingMs` is normally headersTimeout + effective
// firstEventTimeout; callers may omit it for an uncapped request-budget slice.
export function attemptBudgetSliceMs(
  remainingBudgetMs: number,
  remainingAttempts: number,
  attemptCeilingMs: number = Number.POSITIVE_INFINITY,
): number {
  const attempts = Math.max(1, Math.trunc(remainingAttempts) || 1);
  const budget = Math.max(0, Math.floor(remainingBudgetMs));
  if (budget <= 0) return 1;

  const ceiling = Number.isFinite(attemptCeilingMs)
    ? Math.max(1, Math.floor(attemptCeilingMs))
    : Number.POSITIVE_INFINITY;
  if (attempts === 1) return Math.max(1, Math.min(budget, ceiling));

  const equalShare = Math.max(1, Math.floor(budget / attempts));
  const reservePerLater = Math.min(MIN_FAILOVER_RESERVE_MS, equalShare);
  const reservedForLater = reservePerLater * (attempts - 1);
  const availableNow = Math.max(1, budget - reservedForLater);
  return Math.max(1, Math.min(availableNow, ceiling));
}

function fairShareTimeoutMs(configuredTimeoutMs: number, remainingBudgetMs: number, remainingAttempts: number, floorMs: number): number {
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

// Phase-local response-header wait. Dispatch normally passes one already
// allocated attempt window here, so the configured header timeout is preserved
// unless the absolute attempt/request budget is tighter. The multi-attempt
// form remains supported for isolated callers/tests.
export function attemptHeadersTimeoutMs(headersTimeoutMs: number, remainingBudgetMs: number, remainingAttempts: number): number {
  return fairShareTimeoutMs(
    headersTimeoutMs, remainingBudgetMs, remainingAttempts, MIN_ATTEMPT_HEADERS_MS,
  );
}

// Phase-local first-event guard. It consumes only the time left in the same
// absolute attempt window after headers, and never exceeds the configured
// first-event timeout. Primary and hedge twin share that same deadline.
export function attemptFirstEventTimeoutMs(firstEventTimeoutMs: number, remainingBudgetMs: number, remainingAttempts: number): number {
  return fairShareTimeoutMs(
    firstEventTimeoutMs, remainingBudgetMs, remainingAttempts, MIN_ATTEMPT_FIRST_EVENT_MS,
  );
}

const cache = new WeakMap<object, Limits>();

export function getLimits(env: Record<string, unknown>): Limits {
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
    maxHedgesPerRequest: clampInt(readEnv(env, 'MAX_HEDGES_PER_REQUEST'), LIMITS.MAX_HEDGES_PER_REQUEST.min, LIMITS.MAX_HEDGES_PER_REQUEST.max, LIMITS.MAX_HEDGES_PER_REQUEST.def),
    gatewayKeyRpm: clampInt(readEnv(env, 'GATEWAY_KEY_RPM'), LIMITS.GATEWAY_KEY_RPM.min, LIMITS.GATEWAY_KEY_RPM.max, LIMITS.GATEWAY_KEY_RPM.def),
  };
  cache.set(env, cached);
  return cached;
}

// Parse a Retry-After header. Supports delay-seconds and HTTP-date forms.
// Returns milliseconds clamped to [RETRY_AFTER_MIN_MS, RETRY_AFTER_MAX_MS], or 0 when absent/invalid.
export function parseRetryAfterMs(headers: Headers, now: number = Date.now()): number {
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
