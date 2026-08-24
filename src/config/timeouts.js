// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Single source of truth for every timeout / cooldown value.
// Do not hardcode timeout defaults anywhere else.

import { readEnv, clampInt } from './env.js';

const LIMITS = {
  UPSTREAM_HEADERS_TIMEOUT_MS: { min: 5_000, max: 600_000, def: 120_000 },
  FIRST_EVENT_TIMEOUT_MS: { min: 5_000, max: 600_000, def: 60_000 },
  STREAM_IDLE_TIMEOUT_MS: { min: 10_000, max: 600_000, def: 120_000 },
  RATE_LIMIT_COOLDOWN_MS: { min: 1_000, max: 600_000, def: 60_000 },
  AUTH_FAIL_COOLDOWN_MS: { min: 60_000, max: 7 * 86_400_000, def: 3_600_000 },
  MAX_BODY_BYTES: { min: 1024, max: 100 * 1024 * 1024, def: 20 * 1024 * 1024 },
};

// Retry-After is always clamped into this window so a hostile or broken
// upstream cannot park a node for hours via one header.
const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 600_000;

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
