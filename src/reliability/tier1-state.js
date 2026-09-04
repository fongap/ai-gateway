// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Isolate-local adaptive state for Tier 1 only. Performance is learned from
// real requests at (account, model) scope. Tier 2/3 continue to use
// node-state.js and never read this module.

import { servesModel } from '../config/registry.js';

export const TIER1_EWMA_ALPHA = 0.25;
export const TIER1_OUTLIER_MULTIPLIER = 4;
export const TIER1_OUTLIER_CONSECUTIVE_THRESHOLD = 2;
export const TIER1_EXPLORATION_FACTOR = 0.9;
export const TIER1_HALF_OPEN_SCORE_PENALTY = 1.4;
export const TIER1_NEUTRAL_TTFT_MS = 800; // scheduling fallback, never stored as an observation
export const TIER1_AFFINITY_FACTOR = 0.85; // one factor: the registry has no logical model tiers
export const TIER1_MAX_ATTEMPTS = 3;

export const TIER1_FAILURE_THRESHOLD = 3;
export const TIER1_HALF_OPEN_SUCCESS_THRESHOLD = 2;
export const TIER1_COOLDOWN_DEFAULT_MS = 30_000;
export const TIER1_COOLDOWN_MAX_MS = 1_800_000;
export const TIER1_TIMEOUT_BASE_MS = 5_000;
export const TIER1_TIMEOUT_MAX_MS = 120_000;
export const TIER1_5XX_BASE_MS = 1_000;
export const TIER1_5XX_MAX_MS = 300_000;
// Auth (401/403) and model_missing (404 heuristic) are NOT permanent
// disables anymore. They get a long cooldown (default 1h) so the same
// isolate can recover on its own if the key is rotated, the model is
// re-added upstream, or the heuristic was a false positive. To force a
// permanent block, set this to 0.
export const TIER1_AUTH_DISABLED_COOLDOWN_MS = 3_600_000;
export const TIER1_MODEL_MISSING_DISABLED_COOLDOWN_MS = 3_600_000;
export const TIER1_429_BASE_MS = 30_000;
export const TIER1_429_MAX_MS = 1_800_000;

const FAILURE_STATE = Object.freeze({
  NORMAL: 'normal',
  COOLDOWN: 'cooldown',
  HALF_OPEN: 'half_open',
  DISABLED: 'disabled',
});

const accounts = new Map();
const rpmBuckets = new Map();

function newModelRuntime() {
  return {
    supported: true,
    disabled: false,
    cooldownUntil: 0,
    cooldownReason: null,
    failureState: FAILURE_STATE.NORMAL,
    consecutiveFailures: 0,
    consecutiveRateLimits: 0,
    consecutiveOutliers: 0,
    halfOpenSuccesses: 0,
    ttftEwma: null,
    sampleCount: 0,
    lastObservedAt: 0,
    scopeAmbiguous429: false,
  };
}

function newAccountRuntime(accountId) {
  return {
    accountId,
    inFlight: 0,
    accountDisabled: false,
    accountCooldownUntil: 0,
    accountCooldownReason: null,
    consecutiveAccountFailures: 0,
    quotaState: 'normal',
    quotaResetAt: 0,
    models: new Map(),
  };
}

export function getTier1Account(accountId) {
  let account = accounts.get(accountId);
  if (!account) {
    account = newAccountRuntime(accountId);
    accounts.set(accountId, account);
  }
  return account;
}

export function getTier1Model(accountId, modelId) {
  const account = getTier1Account(accountId);
  let model = account.models.get(modelId);
  if (!model) {
    model = newModelRuntime();
    account.models.set(modelId, model);
  }
  return model;
}

export function getTier1ModelPerf(accountId, modelId) {
  return accounts.get(accountId)?.models.get(modelId) ?? null;
}

export function tier1AccountInFlight(accountId) {
  return accounts.get(accountId)?.inFlight ?? 0;
}

function minuteOf(now) { return Math.floor(now / 60_000); }

function noteTier1Rpm(accountId, now) {
  const minute = minuteOf(now);
  const bucket = rpmBuckets.get(accountId);
  if (!bucket || bucket.minute !== minute) rpmBuckets.set(accountId, { minute, count: 1 });
  else bucket.count++;
}

export function tier1RpmUsage(accountId, now = Date.now()) {
  const bucket = rpmBuckets.get(accountId);
  return bucket?.minute === minuteOf(now) ? bucket.count : 0;
}

export function rollbackTier1Rpm(accountId, now = Date.now()) {
  const bucket = rpmBuckets.get(accountId);
  if (bucket?.minute === minuteOf(now)) bucket.count = Math.max(0, bucket.count - 1);
}

export function claimTier1Slot(node, now = Date.now(), modelId = null) {
  const account = getTier1Account(node.id);
  if (account.accountDisabled || account.accountCooldownUntil > now) return false;
  const model = modelId ? account.models.get(modelId) : null;
  if (model?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return false;
  if (account.inFlight >= node.limits.concurrency) return false;
  if (node.limits.rpm && node.limits.rpmMode !== 'soft'
    && tier1RpmUsage(node.id, now) >= node.limits.rpm) return false;
  account.inFlight++;
  noteTier1Rpm(node.id, now);
  return true;
}

export function makeTier1ReleaseToken(accountId) {
  return { accountId, released: false };
}

export function releaseTier1Slot(accountId, token) {
  if (!token || token.accountId !== accountId || token.released) return false;
  token.released = true;
  const account = accounts.get(accountId);
  if (account) account.inFlight = Math.max(0, account.inFlight - 1);
  return true;
}

function modelBlocked(model, now) {
  return model?.disabled || (model?.cooldownUntil ?? 0) > now;
}

// Read-only eligibility filter. Missing runtime state means UNKNOWN, not bad.
// `knownModels` (the Known Model Catalog) bounds wildcard nodes: an
// empty-models node serves only catalog models, never an arbitrary string.
export function isTier1Eligible(node, req, now = Date.now(), knownModels) {
  if (!node || node.tier !== 'tier-1') return false;
  if (node.protocol !== req.protocol) return false;
  if (!Array.isArray(node.surfaces) || !node.surfaces.includes(req.surface)) return false;
  if (!servesModel(node, req.model, knownModels)) return false;
  const account = accounts.get(node.id);
  if (!account) return true;
  if (account.accountDisabled || account.accountCooldownUntil > now) return false;
  if (modelBlocked(account.models.get(req.model), now)) return false;
  if (account.models.get(req.model)?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return false;
  if (account.inFlight >= node.limits.concurrency) return false;
  if (node.limits.rpm && node.limits.rpmMode !== 'soft'
    && tier1RpmUsage(node.id, now) >= node.limits.rpm) return false;
  if (account.quotaState === 'exhausted_until' && account.quotaResetAt > now) return false;
  return true;
}

export function maybeTransitionToHalfOpen(accountId, modelId, now = Date.now()) {
  const model = accounts.get(accountId)?.models.get(modelId);
  if (model?.failureState === FAILURE_STATE.COOLDOWN && model.cooldownUntil <= now) {
    model.failureState = FAILURE_STATE.HALF_OPEN;
    model.halfOpenSuccesses = 0;
  }
}

export function tier1CountDispatchableNodes(nodes, req, attempted, now = Date.now(), knownModels) {
  let count = 0;
  for (const node of nodes ?? []) {
    if (attempted.has(node.id)) continue;
    maybeTransitionToHalfOpen(node.id, req.model, now);
    if (isTier1Eligible(node, req, now, knownModels)) count++;
  }
  return count;
}

export function tier1HasDispatchableNode(nodes, req, attempted, now = Date.now(), knownModels) {
  return tier1CountDispatchableNodes(nodes, req, attempted, now, knownModels) > 0;
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function effectiveTier1Ttft(accountId, modelId, candidates) {
  const own = getTier1ModelPerf(accountId, modelId);
  if (own?.ttftEwma != null && own.sampleCount > 0) return own.ttftEwma;
  const known = [];
  for (const candidate of candidates ?? []) {
    if (candidate.id === accountId) continue;
    const metric = getTier1ModelPerf(candidate.id, modelId);
    if (metric?.ttftEwma != null && metric.sampleCount > 0) known.push(metric.ttftEwma);
  }
  return known.length ? median(known) : TIER1_NEUTRAL_TTFT_MS;
}

function loadFactor(node) {
  const capacity = node.limits?.concurrency;
  if (!capacity) return 1;
  return 1 + 0.5 * Math.min(1, tier1AccountInFlight(node.id) / capacity);
}

function failureFactor(accountId, modelId) {
  return getTier1ModelPerf(accountId, modelId)?.failureState === FAILURE_STATE.HALF_OPEN
    ? TIER1_HALF_OPEN_SCORE_PENALTY : 1;
}

function quotaFactor(accountId, now) {
  const account = accounts.get(accountId);
  if (!account || (account.quotaState === 'exhausted_until' && account.quotaResetAt <= now)) return 1;
  return account.quotaState === 'near_limit' ? 1.2 : 1;
}

function explorationFactor(accountId, modelId) {
  const metric = getTier1ModelPerf(accountId, modelId);
  return !metric || metric.ttftEwma == null || metric.sampleCount === 0
    ? TIER1_EXPLORATION_FACTOR : 1;
}

export function calculateTier1Score(node, modelId, candidates, affinityFactor = 1, now = Date.now()) {
  return Math.max(1,
    effectiveTier1Ttft(node.id, modelId, candidates)
    * loadFactor(node)
    * failureFactor(node.id, modelId)
    * quotaFactor(node.id, now)
    * affinityFactor
    * explorationFactor(node.id, modelId));
}

export function recordTier1Ttft(accountId, modelId, observedMs, now = Date.now()) {
  if (!Number.isFinite(observedMs) || observedMs < 0) return false;
  const model = getTier1Model(accountId, modelId);
  if (model.ttftEwma == null || model.sampleCount === 0) {
    model.ttftEwma = observedMs;
    model.consecutiveOutliers = 0;
  } else {
    const threshold = model.ttftEwma * TIER1_OUTLIER_MULTIPLIER;
    let effectiveSample = observedMs;
    if (observedMs > threshold) {
      model.consecutiveOutliers++;
      if (model.consecutiveOutliers < TIER1_OUTLIER_CONSECUTIVE_THRESHOLD) effectiveSample = threshold;
    } else {
      model.consecutiveOutliers = 0;
    }
    model.ttftEwma = TIER1_EWMA_ALPHA * effectiveSample
      + (1 - TIER1_EWMA_ALPHA) * model.ttftEwma;
  }
  model.sampleCount++;
  model.lastObservedAt = now;
  return true;
}

/** @param {{ retryAfterMs?: number }} opts */
export function classifyTier1Failure(classification, opts = {}) {
  const { retryAfterMs } = opts;
  const kind = classification?.kind;
  if (kind === 'auth') return { scope: 'account', action: 'disable', reason: kind };
  if (kind === 'model_missing') return { scope: 'model', action: 'disable', reason: kind };
  if (kind === 'endpoint_not_found') {
    return { scope: 'account', action: 'cooldown', counted: false, cooldownMs: classification.cooldownMs || 5_000, reason: kind };
  }
  if (kind === 'rate_limit') {
    const explicit = retryAfterMs ?? classification?.retryAfterMs ?? 0;
    return {
      scope: classification?.rateLimitScope === 'account' ? 'account' : 'model',
      action: 'cooldown', counted: false, cooldownMs: explicit,
      backoff: 'rate_limit', reason: kind,
      scopeAmbiguous: !classification?.rateLimitScope,
    };
  }
  if (kind === 'client' || kind === 'client_abort') {
    return { scope: 'none', action: 'neutral', counted: false, cooldownMs: 0, reason: kind };
  }
  if (kind === 'headers_timeout' || kind === 'first_event_timeout' || kind === 'network' || kind === 'stream_interrupted') {
    return { scope: 'model', action: 'cooldown', counted: true, cooldownMs: 0, backoff: 'timeout', reason: kind };
  }
  if (kind === 'server') {
    return { scope: 'model', action: 'cooldown', counted: true, cooldownMs: 0, backoff: 'server', reason: kind };
  }
  return { scope: 'model', action: 'cooldown', counted: true, cooldownMs: 0, backoff: 'default', reason: kind || 'unknown' };
}

function exponential(base, max, count) {
  return Math.min(max, base * 2 ** Math.max(0, count - 1));
}

// Apply a light ±10% jitter to an automatically-computed cooldown. This
// avoids different isolates re-probing the same failing upstream at the
// exact same instant. Explicit Retry-After values are NOT jittered — only
// auto-computed backoffs are.
const JITTER_FACTOR = 0.1;
function jitter(ms) {
  if (ms <= 0) return ms;
  const delta = ms * JITTER_FACTOR;
  return Math.round(ms + (Math.random() * 2 - 1) * delta);
}

function modelCooldownMs(model, outcome) {
  if (outcome.cooldownMs > 0) return Math.min(outcome.cooldownMs, TIER1_COOLDOWN_MAX_MS);
  if (outcome.backoff === 'rate_limit') return jitter(exponential(TIER1_429_BASE_MS, TIER1_429_MAX_MS, model.consecutiveRateLimits));
  if (outcome.backoff === 'timeout') return jitter(exponential(TIER1_TIMEOUT_BASE_MS, TIER1_TIMEOUT_MAX_MS, model.consecutiveFailures));
  if (outcome.backoff === 'server') return jitter(exponential(TIER1_5XX_BASE_MS, TIER1_5XX_MAX_MS, model.consecutiveFailures));
  return jitter(exponential(TIER1_COOLDOWN_DEFAULT_MS, TIER1_COOLDOWN_MAX_MS, model.consecutiveFailures));
}

export function applyTier1Outcome(accountId, modelId, outcome, now = Date.now()) {
  if (!outcome || outcome.action === 'neutral' || outcome.scope === 'none') return;
  const account = getTier1Account(accountId);
  if (outcome.action === 'disable') {
    // 'disable' (auth / model_missing) is no longer permanent. We apply a
    // long cooldown so the node self-recovers when the key is rotated, the
    // model is re-added, or the 404 heuristic was a false positive. To
    // opt out, set TIER1_AUTH_DISABLED_COOLDOWN_MS=0 and
    // TIER1_MODEL_MISSING_DISABLED_COOLDOWN_MS=0 to restore the old
    // "disabled until isolate restart" behavior.
    const ms = outcome.reason === 'auth' ? TIER1_AUTH_DISABLED_COOLDOWN_MS
      : outcome.reason === 'model_missing' ? TIER1_MODEL_MISSING_DISABLED_COOLDOWN_MS
      : 0;
    if (ms > 0) {
      if (outcome.scope === 'account') {
        account.accountDisabled = false;
        account.accountCooldownUntil = Math.max(account.accountCooldownUntil, now + ms);
        account.accountCooldownReason = outcome.reason;
      } else {
        const model = getTier1Model(accountId, modelId);
        model.disabled = false;
        model.failureState = FAILURE_STATE.COOLDOWN;
        model.cooldownUntil = Math.max(model.cooldownUntil, now + ms);
        model.cooldownReason = outcome.reason;
      }
      return;
    }
    // Legacy permanent-disable path (cooldown = 0 means operator wants hard disable).
    if (outcome.scope === 'account') {
      account.accountDisabled = true;
      account.accountCooldownReason = outcome.reason;
    } else {
      const model = getTier1Model(accountId, modelId);
      model.disabled = true;
      model.failureState = FAILURE_STATE.DISABLED;
      model.cooldownReason = outcome.reason;
    }
    return;
  }
  if (outcome.scope === 'account') {
    account.consecutiveAccountFailures++;
    account.accountCooldownUntil = Math.max(account.accountCooldownUntil, now + (outcome.cooldownMs || TIER1_COOLDOWN_DEFAULT_MS));
    account.accountCooldownReason = outcome.reason;
    return;
  }

  const model = getTier1Model(accountId, modelId);
  if (outcome.scopeAmbiguous) model.scopeAmbiguous429 = true;
  if (outcome.backoff === 'rate_limit') model.consecutiveRateLimits++;
  else model.consecutiveRateLimits = 0;
  if (outcome.counted) model.consecutiveFailures++;

  const halfOpenFailure = model.failureState === FAILURE_STATE.HALF_OPEN;
  const thresholdReached = outcome.counted && model.consecutiveFailures >= TIER1_FAILURE_THRESHOLD;
  const rateLimited = outcome.backoff === 'rate_limit';
  if (halfOpenFailure || thresholdReached || rateLimited || outcome.cooldownMs > 0) {
    model.cooldownUntil = now + modelCooldownMs(model, outcome);
    model.cooldownReason = outcome.reason;
    if (halfOpenFailure || thresholdReached) {
      model.failureState = FAILURE_STATE.COOLDOWN;
      model.halfOpenSuccesses = 0;
    }
  }
}

export function recordTier1Success(accountId, modelId) {
  const account = getTier1Account(accountId);
  const model = getTier1Model(accountId, modelId);
  account.consecutiveAccountFailures = 0;
  model.consecutiveFailures = 0;
  model.consecutiveRateLimits = 0;
  if (model.failureState === FAILURE_STATE.HALF_OPEN) {
    model.halfOpenSuccesses++;
    if (model.halfOpenSuccesses >= TIER1_HALF_OPEN_SUCCESS_THRESHOLD) {
      model.failureState = FAILURE_STATE.NORMAL;
      model.halfOpenSuccesses = 0;
      model.cooldownUntil = 0;
      model.cooldownReason = null;
    }
  }
}

export function tier1FailureState(accountId, modelId) {
  return getTier1ModelPerf(accountId, modelId)?.failureState ?? FAILURE_STATE.NORMAL;
}

export function tier1BlockingWaitMs(node, modelId, now = Date.now()) {
  const account = accounts.get(node.id);
  if (!account || account.accountDisabled) return Infinity;
  if (account.accountCooldownUntil > now) return account.accountCooldownUntil - now;
  const model = account.models.get(modelId);
  if (model?.disabled) return Infinity;
  if (model?.cooldownUntil > now) return model.cooldownUntil - now;
  if (model?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return 1_000;
  if (node.limits.rpm && node.limits.rpmMode !== 'soft'
    && tier1RpmUsage(node.id, now) >= node.limits.rpm) return Math.max(1, 60_000 - (now % 60_000));
  if (account.inFlight >= node.limits.concurrency) return 1_000;
  return Infinity;
}

export function tier1HasDeferredCapacity(nodes, req, attempted, now = Date.now(), knownModels) {
  for (const node of nodes ?? []) {
    if (attempted.has(node.id) || node.tier !== 'tier-1') continue;
    if (node.protocol !== req.protocol || !node.surfaces?.includes(req.surface) || !servesModel(node, req.model, knownModels)) continue;
    const account = accounts.get(node.id);
    if (!account || account.accountDisabled || account.accountCooldownUntil > now) continue;
    const model = account.models.get(req.model);
    if (modelBlocked(model, now)) continue;
    if (model?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return true;
    if (account.inFlight >= node.limits.concurrency) return true;
    if (node.limits.rpm && node.limits.rpmMode !== 'soft'
      && tier1RpmUsage(node.id, now) >= node.limits.rpm) return true;
  }
  return false;
}

// Only explicit, comparable provider data may call this interface.
/** @param {{ remainingRatio?: number, resetAtMs?: number }} signal */
export function recordTier1QuotaSignal(accountId, signal = {}, now = Date.now()) {
  const { remainingRatio, resetAtMs = 0 } = signal;
  if (!Number.isFinite(remainingRatio) || remainingRatio < 0 || remainingRatio > 1) return false;
  const account = getTier1Account(accountId);
  if (remainingRatio === 0 && resetAtMs > now) {
    account.quotaState = 'exhausted_until';
    account.quotaResetAt = resetAtMs;
  } else if (remainingRatio <= 0.1) {
    account.quotaState = 'near_limit';
  } else {
    account.quotaState = 'normal';
    account.quotaResetAt = 0;
  }
  return true;
}

function modelDiagnosticState(model, now) {
  if (!model) return 'configured';
  if (model.disabled || model.failureState === FAILURE_STATE.DISABLED) return 'disabled';
  if (model.cooldownUntil > now || model.failureState === FAILURE_STATE.COOLDOWN) return 'cooldown';
  if (model.failureState === FAILURE_STATE.HALF_OPEN) return 'half_open';
  if (model.sampleCount > 0) return 'observed_healthy';
  return 'unknown';
}

export function snapshotTier1Runtime(accountId, modelId, now = Date.now()) {
  const account = accounts.get(accountId);
  const model = account?.models.get(modelId);
  return {
    account_id: accountId,
    model: modelId,
    state: account?.accountDisabled ? 'disabled'
      : account?.accountCooldownUntil > now ? 'cooldown'
      : modelDiagnosticState(model, now),
    account_disabled: account?.accountDisabled ?? false,
    account_cooldown_remaining_ms: account?.accountCooldownUntil > now ? account.accountCooldownUntil - now : 0,
    in_flight: account?.inFlight ?? 0,
    quota_state: account?.quotaState === 'exhausted_until' && account.quotaResetAt <= now
      ? 'normal' : account?.quotaState ?? 'normal',
    quota_reset_at: account?.quotaResetAt > now ? new Date(account.quotaResetAt).toISOString() : null,
    failure_state: model?.failureState ?? FAILURE_STATE.NORMAL,
    consecutive_failures: model?.consecutiveFailures ?? 0,
    consecutive_rate_limits: model?.consecutiveRateLimits ?? 0,
    consecutive_outliers: model?.consecutiveOutliers ?? 0,
    half_open_successes: model?.halfOpenSuccesses ?? 0,
    cooldown_remaining_ms: model?.cooldownUntil > now ? model.cooldownUntil - now : 0,
    cooldown_reason: model?.cooldownUntil > now ? model.cooldownReason : null,
    ttft_ewma_ms: model?.ttftEwma == null ? null : Math.round(model.ttftEwma),
    sample_count: model?.sampleCount ?? 0,
    last_observed_at: model?.lastObservedAt > 0 ? new Date(model.lastObservedAt).toISOString() : null,
    scope_ambiguous_429: model?.scopeAmbiguous429 ?? false,
  };
}

export function snapshotTier1AccountRuntime(accountId, modelIds = [], now = Date.now()) {
  const account = accounts.get(accountId);
  const ids = new Set(modelIds);
  for (const id of account?.models.keys() ?? []) ids.add(id);
  const models = [...ids].sort().map((id) => snapshotTier1Runtime(accountId, id, now));
  return {
    state: account?.accountDisabled ? 'disabled'
      : account?.accountCooldownUntil > now ? 'cooldown'
      : models.some((m) => m.state === 'observed_healthy') ? 'observed_healthy'
      : account ? 'unknown' : 'configured',
    in_flight: account?.inFlight ?? 0,
    account_disabled: account?.accountDisabled ?? false,
    account_cooldown_remaining_ms: account?.accountCooldownUntil > now ? account.accountCooldownUntil - now : 0,
    models,
  };
}

export function __resetTier1StateForTests() {
  accounts.clear();
  rpmBuckets.clear();
}

export const TIER1_FAILURE_STATES = FAILURE_STATE;
