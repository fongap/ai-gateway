const RETRYABLE_STATUS = new Set([401, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_TOTAL_ATTEMPTS = 5;

export function isRetryable(status) {
  return RETRYABLE_STATUS.has(status);
}

export function checkRetryBudget(attemptsMade, policy) {
  const total = attemptsMade.reduce((sum, a) => sum + a, 0);
  if (total >= MAX_TOTAL_ATTEMPTS) return false;
  return true;
}

export function getAttemptBudget(policy, tier) {
  const budget = policy.retry_budget || { free: 2, paid: 1, plus: 1 };
  return budget[tier] || 1;
}

export function shouldRetry(attemptIndex, maxAttempts, status, tier, policy) {
  if (attemptIndex >= maxAttempts) return false;
  if (!isRetryable(status)) return false;
  const tierBudget = getAttemptBudget(policy, tier);
  if (attemptIndex >= tierBudget) return false;
  return true;
}

export const UPSTREAM_HEADERS_TIMEOUT = 30_000;
export const FIRST_EVENT_TIMEOUT = 60_000;
export const STREAM_IDLE_TIMEOUT = 120_000;

export function getTimeouts(env) {
  return {
    headersTimeout: clampInt(env?.UPSTREAM_HEADERS_TIMEOUT, 5_000, 60_000, UPSTREAM_HEADERS_TIMEOUT),
    firstEventTimeout: clampInt(env?.FIRST_EVENT_TIMEOUT, 10_000, 120_000, FIRST_EVENT_TIMEOUT),
    streamIdleTimeout: clampInt(env?.STREAM_IDLE_TIMEOUT, 30_000, 300_000, STREAM_IDLE_TIMEOUT),
  };
}

function clampInt(value, min, max, fallback) {
  const num = parseInt(value, 10);
  return Number.isFinite(num) ? Math.max(min, Math.min(max, num)) : fallback;
}