// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Isolate-local adaptive state for Tier 1 only. Performance is learned from
// real requests at (account, model) scope. Tier 2/3 continue to use
// node-state.ts and never read this module.

import { servesModel } from '../config/registry.ts';
import type { RuntimeNode } from '../types/node.ts';
import type { RoutableRequest } from '../types/scheduler.ts';

export const TIER1_EWMA_ALPHA = 0.25;
export const TIER1_OUTLIER_MULTIPLIER = 4;
export const TIER1_OUTLIER_CONSECUTIVE_THRESHOLD = 2;
export const TIER1_EXPLORATION_FACTOR = 0.9;
export const TIER1_HALF_OPEN_SCORE_PENALTY = 1.4;
export const TIER1_NEUTRAL_TTFT_MS = 800; // scheduling fallback, never stored as an observation
export const TIER1_AFFINITY_FACTOR = 0.85; // one factor: the registry has no logical model tiers

// TTFT scoring: bounded multiplicative demotion (not raw score base).
export const TIER1_SCORE_BASE = 1000;
export const TIER1_TTFT_WEIGHT = 0.25;
export const TIER1_TTFT_FACTOR_MIN = 0.85; // fast nodes get at most 0.85x
export const TIER1_TTFT_FACTOR_MAX = 1.50; // slow nodes get at most 1.50x

export const TIER1_FAILURE_THRESHOLD = 3;
export const TIER1_HALF_OPEN_SUCCESS_THRESHOLD = 2;
export const TIER1_COOLDOWN_DEFAULT_MS = 30_000;
export const TIER1_COOLDOWN_MAX_MS = 1_800_000;
export const TIER1_TIMEOUT_BASE_MS = 5_000;
export const TIER1_TIMEOUT_MAX_MS = 120_000;
export const TIER1_5XX_BASE_MS = 1_000;
export const TIER1_5XX_MAX_MS = 300_000;
// Auth (401/403) is account-scoped and intentionally long-lived so the same
// isolate can recover on its own after a key rotation without repeatedly
// hammering a rejected credential. To force a permanent block, set this to 0.
export const TIER1_AUTH_DISABLED_COOLDOWN_MS = 3_600_000;
export const TIER1_429_BASE_MS = 30_000;
export const TIER1_429_MAX_MS = 1_800_000;

const FAILURE_STATE = Object.freeze({
  NORMAL: 'normal',
  COOLDOWN: 'cooldown',
  HALF_OPEN: 'half_open',
  DISABLED: 'disabled',
} as const);

export type Tier1FailureState = typeof FAILURE_STATE[keyof typeof FAILURE_STATE];

export type Tier1ModelRuntime = {
  supported: boolean,
  disabled: boolean,
  cooldownUntil: number,
  cooldownReason: string | null,
  failureState: Tier1FailureState,
  consecutiveFailures: number,
  consecutiveRateLimits: number,
  consecutiveOutliers: number,
  halfOpenSuccesses: number,
  ttftEwma: number | null,
  sampleCount: number,
  lastObservedAt: number,
  scopeAmbiguous429: boolean,
  rateLimitRecoveryPending: boolean,
  rateLimitRecoveryUntil: number,
};

export type Tier1QuotaState = 'normal' | 'near_limit' | 'exhausted_until';

export type Tier1AccountRuntime = {
  accountId: string,
  inFlight: number,
  accountDisabled: boolean,
  accountCooldownUntil: number,
  accountCooldownReason: string | null,
  consecutiveAccountFailures: number,
  rateLimitRecoveryPending: boolean,
  rateLimitRecoveryUntil: number,
  quotaState: Tier1QuotaState,
  quotaResetAt: number,
  // model_missing is about the provider-facing model id, not the gateway's
  // logical alias. Keep that short cooldown separate from logical-model
  // performance/circuit state so remapping Code-Max does not inherit stale 404s.
  upstreamModelCooldowns: Map<string, number>,
  models: Map<string, Tier1ModelRuntime>,
};

export type Tier1ReleaseToken = { accountId: string, released: boolean };

/** Failure-kind classification input consumed from the reliability layer.
 * `kind` is an open string: stream-layer kinds (e.g. 'stream_interrupted')
 * also flow through here, carrying the stream-layer `streamReason`. */
export type Tier1FailureInput = {
  kind?: string,
  cooldownMs?: number,
  retryAfterMs?: number,
  rateLimitScope?: string,
  streamReason?: unknown,
} | null | undefined;

export type Tier1Outcome = {
  scope: 'account' | 'model' | 'upstream_model' | 'none',
  action: 'disable' | 'cooldown' | 'neutral',
  reason: string,
  counted?: boolean,
  cooldownMs?: number,
  backoff?: 'rate_limit' | 'timeout' | 'server' | 'default',
  scopeAmbiguous?: boolean,
};

const accounts = new Map<string, Tier1AccountRuntime>();

type Tier1RpmBucket = {
  tokens: number,
  updatedAt: number,
  rpm: number,
};

// Tier 1 hard-RPM admission is intentionally isolate-local. A capacity of at
// most two tokens permits one small burst while continuous refill removes the
// fixed-minute boundary spike. No new configuration surface is introduced:
// node.limits.rpm remains the single rate input.
const TIER1_RPM_BURST_TOKENS = 2;
const rpmBuckets = new Map<string, Tier1RpmBucket>();

function newModelRuntime(): Tier1ModelRuntime {
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
    rateLimitRecoveryPending: false,
    rateLimitRecoveryUntil: 0,
  };
}

function newAccountRuntime(accountId: string): Tier1AccountRuntime {
  return {
    accountId,
    inFlight: 0,
    accountDisabled: false,
    accountCooldownUntil: 0,
    accountCooldownReason: null,
    consecutiveAccountFailures: 0,
    rateLimitRecoveryPending: false,
    rateLimitRecoveryUntil: 0,
    quotaState: 'normal',
    quotaResetAt: 0,
    upstreamModelCooldowns: new Map(),
    models: new Map(),
  };
}

export function getTier1Account(accountId: string): Tier1AccountRuntime {
  let account = accounts.get(accountId);
  if (!account) {
    account = newAccountRuntime(accountId);
    accounts.set(accountId, account);
  }
  return account;
}

export function getTier1Model(accountId: string, modelId: string): Tier1ModelRuntime {
  const account = getTier1Account(accountId);
  let model = account.models.get(modelId);
  if (!model) {
    model = newModelRuntime();
    account.models.set(modelId, model);
  }
  return model;
}

export function getTier1ModelPerf(accountId: string, modelId: string): Tier1ModelRuntime | null {
  return accounts.get(accountId)?.models.get(modelId) ?? null;
}

export function tier1AccountInFlight(accountId: string): number {
  return accounts.get(accountId)?.inFlight ?? 0;
}

function tier1UpstreamModelOf(node: RuntimeNode, logicalModel: string): string {
  return node.models[logicalModel] || logicalModel;
}

function upstreamModelCooldownRemainingMs(account: Tier1AccountRuntime, node: RuntimeNode, logicalModel: string, now: number): number {
  const until = account.upstreamModelCooldowns.get(tier1UpstreamModelOf(node, logicalModel)) ?? 0;
  return until > now ? until - now : 0;
}

function tier1RpmCapacity(rpm: number): number {
  return Math.max(1, Math.min(TIER1_RPM_BURST_TOKENS, Math.floor(rpm)));
}

function refilledTier1RpmTokens(bucket: Tier1RpmBucket, now: number): number {
  const capacity = tier1RpmCapacity(bucket.rpm);
  const elapsed = Math.max(0, now - bucket.updatedAt);
  return Math.min(capacity, bucket.tokens + elapsed * (bucket.rpm / 60_000));
}

export function tier1RpmWaitMs(accountId: string, rpm: number, now: number = Date.now()): number {
  if (!Number.isFinite(rpm) || rpm <= 0) return 0;
  const bucket = rpmBuckets.get(accountId);
  if (!bucket || bucket.rpm !== rpm) return 0;
  const tokens = refilledTier1RpmTokens(bucket, now);
  if (tokens >= 1) return 0;
  return Math.max(1, Math.ceil((1 - tokens) * (60_000 / rpm)));
}

function noteTier1Rpm(accountId: string, rpm: number, now: number): boolean {
  if (!Number.isFinite(rpm) || rpm <= 0) return true;
  const capacity = tier1RpmCapacity(rpm);
  const previous = rpmBuckets.get(accountId);
  const tokens = !previous || previous.rpm !== rpm
    ? capacity
    : refilledTier1RpmTokens(previous, now);
  if (tokens < 1) return false;
  rpmBuckets.set(accountId, { tokens: Math.max(0, tokens - 1), updatedAt: now, rpm });
  return true;
}

// Compatibility diagnostic: this is the current token deficit in the smooth
// admission bucket, not a fixed-calendar-minute request counter.
export function tier1RpmUsage(accountId: string, now: number = Date.now()): number {
  const bucket = rpmBuckets.get(accountId);
  if (!bucket) return 0;
  return Math.max(0, tier1RpmCapacity(bucket.rpm) - refilledTier1RpmTokens(bucket, now));
}

export function rollbackTier1Rpm(accountId: string, now: number = Date.now()): void {
  const bucket = rpmBuckets.get(accountId);
  if (!bucket) return;
  const capacity = tier1RpmCapacity(bucket.rpm);
  const tokens = refilledTier1RpmTokens(bucket, now);
  bucket.tokens = Math.min(capacity, tokens + 1);
  bucket.updatedAt = now;
}

export function claimTier1Slot(node: RuntimeNode, now: number = Date.now(), modelId: string | null = null): boolean {
  const account = getTier1Account(node.id);
  if (account.accountDisabled || account.accountCooldownUntil > now || account.rateLimitRecoveryUntil > now) return false;
  const model = modelId ? account.models.get(modelId) : null;
  if (modelId && upstreamModelCooldownRemainingMs(account, node, modelId, now) > 0) return false;
  if ((model?.rateLimitRecoveryUntil ?? 0) > now) return false;
  if (model?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return false;
  if (account.inFlight >= node.limits.concurrency) return false;

  const rpm = node.limits.rpm ?? 0;
  const hardRpm = rpm > 0 && node.limits.rpmMode !== 'soft';
  if (hardRpm && !noteTier1Rpm(node.id, rpm, now)) return false;

  account.inFlight++;
  // A 429 recovery is scoped exactly like the cooldown that caused it. The
  // first admitted request after cooldown starts a one-interval recovery gate;
  // model-scoped 429 never blocks sibling models, while account-scoped 429
  // intentionally gates the whole account. The shared RPM bucket itself is
  // never pushed into the future, so unrelated model traffic keeps flowing.
  if (account.rateLimitRecoveryPending) {
    account.rateLimitRecoveryPending = false;
    account.rateLimitRecoveryUntil = hardRpm ? now + (60_000 / rpm) : 0;
  }
  if (model?.rateLimitRecoveryPending) {
    model.rateLimitRecoveryPending = false;
    model.rateLimitRecoveryUntil = hardRpm ? now + (60_000 / rpm) : 0;
  }
  return true;
}

export function makeTier1ReleaseToken(accountId: string): Tier1ReleaseToken {
  return { accountId, released: false };
}

export function releaseTier1Slot(accountId: string, token: Tier1ReleaseToken | null | undefined): boolean {
  if (!token || token.accountId !== accountId || token.released) return false;
  token.released = true;
  const account = accounts.get(accountId);
  if (account) account.inFlight = Math.max(0, account.inFlight - 1);
  return true;
}

function modelBlocked(model: Tier1ModelRuntime | null | undefined, now: number): boolean {
  return model?.disabled || (model?.cooldownUntil ?? 0) > now;
}

// Read-only eligibility filter. Missing runtime state means UNKNOWN, not bad.
// `knownModels` (the Known Model Catalog) bounds wildcard nodes: an
// empty-models node serves only catalog models, never an arbitrary string.
export function isTier1Eligible(node: RuntimeNode, req: RoutableRequest, now: number = Date.now(), knownModels?: ReadonlySet<string> | null): boolean {
  if (!node || node.tier !== 'tier-1') return false;
  if (node.protocol !== req.protocol) return false;
  if (!Array.isArray(node.surfaces) || !node.surfaces.includes(req.surface)) return false;
  if (!servesModel(node, req.model, knownModels)) return false;
  const account = accounts.get(node.id);
  if (!account) return true;
  if (account.accountDisabled || account.accountCooldownUntil > now || account.rateLimitRecoveryUntil > now) return false;
  if (upstreamModelCooldownRemainingMs(account, node, req.model, now) > 0) return false;
  const model = account.models.get(req.model);
  if (modelBlocked(model, now) || (model?.rateLimitRecoveryUntil ?? 0) > now) return false;
  if (model?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return false;
  if (account.inFlight >= node.limits.concurrency) return false;
  if (node.limits.rpm && node.limits.rpmMode !== 'soft'
    && tier1RpmWaitMs(node.id, node.limits.rpm, now) > 0) return false;
  if (account.quotaState === 'exhausted_until' && account.quotaResetAt > now) return false;
  return true;
}

export function maybeTransitionToHalfOpen(accountId: string, modelId: string, now: number = Date.now()): void {
  const model = accounts.get(accountId)?.models.get(modelId);
  if (model?.failureState === FAILURE_STATE.COOLDOWN && model.cooldownUntil <= now) {
    model.failureState = FAILURE_STATE.HALF_OPEN;
    model.halfOpenSuccesses = 0;
  }
}

export function tier1CountDispatchableNodes(nodes: ReadonlyArray<RuntimeNode>, req: RoutableRequest, attempted: Set<string>, now: number = Date.now(), knownModels?: ReadonlySet<string> | null): number {
  let count = 0;
  for (const node of nodes ?? []) {
    if (attempted.has(node.id)) continue;
    maybeTransitionToHalfOpen(node.id, req.model, now);
    if (isTier1Eligible(node, req, now, knownModels)) count++;
  }
  return count;
}

export function tier1HasDispatchableNode(nodes: ReadonlyArray<RuntimeNode>, req: RoutableRequest, attempted: Set<string>, now: number = Date.now(), knownModels?: ReadonlySet<string> | null): boolean {
  return tier1CountDispatchableNodes(nodes, req, attempted, now, knownModels) > 0;
}

function median(values: ReadonlyArray<number>): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function effectiveTier1Ttft(accountId: string, modelId: string, candidates: ReadonlyArray<RuntimeNode>): number {
  const own = getTier1ModelPerf(accountId, modelId);
  if (own?.ttftEwma != null && own.sampleCount > 0) return own.ttftEwma;
  const known: number[] = [];
  for (const candidate of candidates ?? []) {
    if (candidate.id === accountId) continue;
    const metric = getTier1ModelPerf(candidate.id, modelId);
    if (metric?.ttftEwma != null && metric.sampleCount > 0) known.push(metric.ttftEwma);
  }
  return known.length ? median(known) : TIER1_NEUTRAL_TTFT_MS;
}

function loadFactor(node: RuntimeNode): number {
  const capacity = node.limits?.concurrency;
  if (!capacity) return 1;
  return 1 + 0.5 * Math.min(1, tier1AccountInFlight(node.id) / capacity);
}

function failureFactor(accountId: string, modelId: string): number {
  return getTier1ModelPerf(accountId, modelId)?.failureState === FAILURE_STATE.HALF_OPEN
    ? TIER1_HALF_OPEN_SCORE_PENALTY : 1;
}

function quotaFactor(accountId: string, now: number): number {
  const account = accounts.get(accountId);
  if (!account || (account.quotaState === 'exhausted_until' && account.quotaResetAt <= now)) return 1;
  return account.quotaState === 'near_limit' ? 1.2 : 1;
}

function explorationFactor(accountId: string, modelId: string): number {
  const metric = getTier1ModelPerf(accountId, modelId);
  return !metric || metric.ttftEwma == null || metric.sampleCount === 0
    ? TIER1_EXPLORATION_FACTOR : 1;
}

// Candidate-pool TTFT baseline: median of all known ttftEwma values in the
// eligible pool. Used to compute a relative ratio — never persisted.
function tier1TtftBaseline(
  modelId: string,
  candidates: ReadonlyArray<RuntimeNode>,
): number {
  const known: number[] = [];
  for (const candidate of candidates ?? []) {
    const metric = getTier1ModelPerf(candidate.id, modelId);
    if (
      metric?.ttftEwma != null
      && metric.sampleCount > 0
      && Number.isFinite(metric.ttftEwma)
    ) {
      known.push(metric.ttftEwma);
    }
  }
  return known.length ? median(known) : TIER1_NEUTRAL_TTFT_MS;
}

// TTFT factor: bounded multiplicative demotion. A node whose ttftEwma is at
// the pool baseline scores 1.0; faster nodes get a bonus (down to
// TIER1_TTFT_FACTOR_MIN = 0.85); slower nodes get a penalty (up to
// TIER1_TTFT_FACTOR_MAX = 1.50). Nodes with no samples return 1.0 (no
// demotion — they keep the exploration factor instead).
function ttftFactor(
  accountId: string,
  modelId: string,
  candidates: ReadonlyArray<RuntimeNode>,
): number {
  const metric = getTier1ModelPerf(accountId, modelId);
  if (
    !metric
    || metric.ttftEwma == null
    || metric.sampleCount === 0
  ) {
    return 1; // no demotion — explorationFactor handles unknown nodes
  }
  const baseline = tier1TtftBaseline(modelId, candidates);
  const ratio = metric.ttftEwma / Math.max(1, baseline);
  return Math.min(
    TIER1_TTFT_FACTOR_MAX,
    Math.max(
      TIER1_TTFT_FACTOR_MIN,
      1 + TIER1_TTFT_WEIGHT * (ratio - 1),
    ),
  );
}

export function calculateTier1Score(node: RuntimeNode, modelId: string, candidates: ReadonlyArray<RuntimeNode>, affinityFactor: number = 1, now: number = Date.now()): number {
  return Math.max(1,
    TIER1_SCORE_BASE
    * ttftFactor(node.id, modelId, candidates)
    * loadFactor(node)
    * failureFactor(node.id, modelId)
    * quotaFactor(node.id, now)
    * affinityFactor
    * explorationFactor(node.id, modelId));
}

export function recordTier1Ttft(accountId: string, modelId: string, observedMs: number, now: number = Date.now()): boolean {
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

export function classifyTier1Failure(classification: Tier1FailureInput, opts: { retryAfterMs?: number } = {}): Tier1Outcome {
  const { retryAfterMs } = opts;
  const kind = classification?.kind;
  if (kind === 'auth') return { scope: 'account', action: 'disable', reason: kind };
  if (kind === 'model_missing') {
    return {
      scope: 'upstream_model', action: 'cooldown', counted: false,
      cooldownMs: classification?.cooldownMs || 5_000, reason: kind,
    };
  }
  if (kind === 'endpoint_not_found') {
    return { scope: 'account', action: 'cooldown', counted: false, cooldownMs: classification?.cooldownMs || 5_000, reason: kind };
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

function exponential(base: number, max: number, count: number): number {
  return Math.min(max, base * 2 ** Math.max(0, count - 1));
}

// Apply a light ±10% jitter to an automatically-computed cooldown. This
// avoids different isolates re-probing the same failing upstream at the
// exact same instant. Explicit Retry-After values are NOT jittered — only
// auto-computed backoffs are.
const JITTER_FACTOR = 0.1;
function jitter(ms: number): number {
  if (ms <= 0) return ms;
  const delta = ms * JITTER_FACTOR;
  return Math.round(ms + (Math.random() * 2 - 1) * delta);
}

function modelCooldownMs(model: Tier1ModelRuntime, outcome: Tier1Outcome): number {
  if ((outcome.cooldownMs ?? 0) > 0) return Math.min(outcome.cooldownMs ?? 0, TIER1_COOLDOWN_MAX_MS);
  if (outcome.backoff === 'rate_limit') return jitter(exponential(TIER1_429_BASE_MS, TIER1_429_MAX_MS, model.consecutiveRateLimits));
  if (outcome.backoff === 'timeout') return jitter(exponential(TIER1_TIMEOUT_BASE_MS, TIER1_TIMEOUT_MAX_MS, model.consecutiveFailures));
  if (outcome.backoff === 'server') return jitter(exponential(TIER1_5XX_BASE_MS, TIER1_5XX_MAX_MS, model.consecutiveFailures));
  return jitter(exponential(TIER1_COOLDOWN_DEFAULT_MS, TIER1_COOLDOWN_MAX_MS, model.consecutiveFailures));
}

export function applyTier1Outcome(accountId: string, modelId: string, outcome: Tier1Outcome | null | undefined, now: number = Date.now()): void {
  if (!outcome || outcome.action === 'neutral' || outcome.scope === 'none') return;
  const account = getTier1Account(accountId);

  if (outcome.scope === 'upstream_model') {
    const cooldownMs = Math.min(Math.max(0, outcome.cooldownMs ?? 0), TIER1_COOLDOWN_MAX_MS);
    if (cooldownMs > 0) {
      const until = now + cooldownMs;
      account.upstreamModelCooldowns.set(
        modelId,
        Math.max(account.upstreamModelCooldowns.get(modelId) ?? 0, until),
      );
    }
    return;
  }

  if (outcome.action === 'disable') {
    // Auth is the only Tier 1 disable-class outcome. It is converted to a long
    // account cooldown so rotated credentials self-recover without isolate restart.
    const ms = outcome.reason === 'auth' ? TIER1_AUTH_DISABLED_COOLDOWN_MS : 0;
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
    if (outcome.backoff === 'rate_limit') {
      account.rateLimitRecoveryPending = true;
      account.rateLimitRecoveryUntil = 0;
    }
    return;
  }

  const model = getTier1Model(accountId, modelId);
  if (outcome.scopeAmbiguous) model.scopeAmbiguous429 = true;
  if (outcome.backoff === 'rate_limit') model.consecutiveRateLimits++;
  else model.consecutiveRateLimits = 0;
  if (outcome.counted) model.consecutiveFailures++;

  const halfOpenFailure = model.failureState === FAILURE_STATE.HALF_OPEN;
  const thresholdReached = outcome.counted === true && model.consecutiveFailures >= TIER1_FAILURE_THRESHOLD;
  const rateLimited = outcome.backoff === 'rate_limit';
  if (halfOpenFailure || thresholdReached || rateLimited || (outcome.cooldownMs ?? 0) > 0) {
    const cooldownMs = modelCooldownMs(model, outcome);
    model.cooldownUntil = now + cooldownMs;
    model.cooldownReason = outcome.reason;
    if (rateLimited) {
      model.rateLimitRecoveryPending = true;
      model.rateLimitRecoveryUntil = 0;
    }
    if (halfOpenFailure || thresholdReached) {
      model.failureState = FAILURE_STATE.COOLDOWN;
      model.halfOpenSuccesses = 0;
    }
  }
}

export function recordTier1Success(accountId: string, modelId: string): void {
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

export function tier1FailureState(accountId: string, modelId: string): Tier1FailureState {
  return getTier1ModelPerf(accountId, modelId)?.failureState ?? FAILURE_STATE.NORMAL;
}

export function tier1BlockingWaitMs(node: RuntimeNode, modelId: string, now: number = Date.now()): number {
  const account = accounts.get(node.id);
  if (!account || account.accountDisabled) return Infinity;
  if (account.accountCooldownUntil > now) return account.accountCooldownUntil - now;
  if (account.rateLimitRecoveryUntil > now) return account.rateLimitRecoveryUntil - now;
  const upstreamModelWait = upstreamModelCooldownRemainingMs(account, node, modelId, now);
  if (upstreamModelWait > 0) return upstreamModelWait;
  const model = account.models.get(modelId);
  if (model?.disabled) return Infinity;
  if (model && model.cooldownUntil > now) return model.cooldownUntil - now;
  if (model && model.rateLimitRecoveryUntil > now) return model.rateLimitRecoveryUntil - now;
  if (model?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return 1_000;
  if (node.limits.rpm && node.limits.rpmMode !== 'soft') {
    const rpmWait = tier1RpmWaitMs(node.id, node.limits.rpm, now);
    if (rpmWait > 0) return rpmWait;
  }
  if (account.inFlight >= node.limits.concurrency) return 1_000;
  return Infinity;
}

export function tier1HasDeferredCapacity(nodes: ReadonlyArray<RuntimeNode>, req: RoutableRequest, attempted: Set<string>, now: number = Date.now(), knownModels?: ReadonlySet<string> | null): boolean {
  for (const node of nodes ?? []) {
    if (attempted.has(node.id) || node.tier !== 'tier-1') continue;
    if (node.protocol !== req.protocol || !node.surfaces?.includes(req.surface) || !servesModel(node, req.model, knownModels)) continue;
    const account = accounts.get(node.id);
    if (!account || account.accountDisabled || account.accountCooldownUntil > now) continue;
    if (account.rateLimitRecoveryUntil > now) return true;
    if (upstreamModelCooldownRemainingMs(account, node, req.model, now) > 0) continue;
    const model = account.models.get(req.model);
    if (modelBlocked(model, now)) continue;
    if ((model?.rateLimitRecoveryUntil ?? 0) > now) return true;
    if (model?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return true;
    if (account.inFlight >= node.limits.concurrency) return true;
    if (node.limits.rpm && node.limits.rpmMode !== 'soft'
      && tier1RpmWaitMs(node.id, node.limits.rpm, now) > 0) return true;
  }
  return false;
}

// Only explicit, comparable provider data may call this interface.
export function recordTier1QuotaSignal(accountId: string, signal: { remainingRatio?: number, resetAtMs?: number } = {}, now: number = Date.now()): boolean {
  const { remainingRatio, resetAtMs = 0 } = signal;
  if (typeof remainingRatio !== 'number' || !Number.isFinite(remainingRatio) || remainingRatio < 0 || remainingRatio > 1) return false;
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

function modelDiagnosticState(model: Tier1ModelRuntime | null | undefined, now: number): string {
  if (!model) return 'configured';
  if (model.disabled || model.failureState === FAILURE_STATE.DISABLED) return 'disabled';
  if (model.cooldownUntil > now || model.failureState === FAILURE_STATE.COOLDOWN) return 'cooldown';
  if (model.failureState === FAILURE_STATE.HALF_OPEN) return 'half_open';
  if (model.sampleCount > 0) return 'observed_healthy';
  return 'unknown';
}

export function snapshotTier1Runtime(accountId: string, modelId: string, now: number = Date.now()) {
  const account = accounts.get(accountId);
  const model = account?.models.get(modelId);
  return {
    account_id: accountId,
    model: modelId,
    state: account?.accountDisabled ? 'disabled'
      : account && account.accountCooldownUntil > now ? 'cooldown'
      : modelDiagnosticState(model, now),
    account_disabled: account?.accountDisabled ?? false,
    account_cooldown_remaining_ms: account && account.accountCooldownUntil > now ? account.accountCooldownUntil - now : 0,
    in_flight: account?.inFlight ?? 0,
    quota_state: account?.quotaState === 'exhausted_until' && (account?.quotaResetAt ?? 0) <= now
      ? 'normal' : account?.quotaState ?? 'normal',
    quota_reset_at: account && account.quotaResetAt > now ? new Date(account.quotaResetAt).toISOString() : null,
    failure_state: model?.failureState ?? FAILURE_STATE.NORMAL,
    consecutive_failures: model?.consecutiveFailures ?? 0,
    consecutive_rate_limits: model?.consecutiveRateLimits ?? 0,
    consecutive_outliers: model?.consecutiveOutliers ?? 0,
    half_open_successes: model?.halfOpenSuccesses ?? 0,
    cooldown_remaining_ms: model && model.cooldownUntil > now ? model.cooldownUntil - now : 0,
    cooldown_reason: model && model.cooldownUntil > now ? model.cooldownReason : null,
    ttft_ewma_ms: model?.ttftEwma == null ? null : Math.round(model.ttftEwma),
    sample_count: model?.sampleCount ?? 0,
    last_observed_at: model && model.lastObservedAt > 0 ? new Date(model.lastObservedAt).toISOString() : null,
    scope_ambiguous_429: model?.scopeAmbiguous429 ?? false,
  };
}

export function snapshotTier1AccountRuntime(accountId: string, modelIds: ReadonlyArray<string> = [], now: number = Date.now()) {
  const account = accounts.get(accountId);
  const ids = new Set(modelIds);
  for (const id of account?.models.keys() ?? []) ids.add(id);
  const models = [...ids].sort().map((id) => snapshotTier1Runtime(accountId, id, now));
  return {
    state: account?.accountDisabled ? 'disabled'
      : account && account.accountCooldownUntil > now ? 'cooldown'
      : models.some((m) => m.state === 'observed_healthy') ? 'observed_healthy'
      : account ? 'unknown' : 'configured',
    in_flight: account?.inFlight ?? 0,
    account_disabled: account?.accountDisabled ?? false,
    account_cooldown_remaining_ms: account && account.accountCooldownUntil > now ? account.accountCooldownUntil - now : 0,
    models,
  };
}

export function __resetTier1StateForTests(): void {
  accounts.clear();
  rpmBuckets.clear();
}

export const TIER1_FAILURE_STATES = FAILURE_STATE;
