// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Isolate-local Tier 2/3 runtime state: health, passive load, latency,
// cooldowns and circuit breaker. Capacity is learned from live outcomes; no
// configured node RPM/concurrency quota exists in this module.

import type { NodeState } from '../types/reliability.ts';

const JITTER_FACTOR = 0.1;
export const CIRCUIT_FAILURE_THRESHOLD = 3;
export const CIRCUIT_OPEN_MS = 30_000;

const HEALTH_INITIAL = 50;
const HEALTH_MIN = 1;
const HEALTH_MAX = 100;
const HEALTH_SUCCESS_GAIN = 3;
const HEALTH_COOLDOWN_RECOVERY = 10;
const LATENCY_EWMA_ALPHA = 0.3;
const PROBE_EWMA_ALPHA = 0.15;
const MAX_STATE_ENTRIES = 256;
const CLEANUP_INTERVAL_MS = 30_000;
const STALE_FAILURE_MS = 300_000;
const MODEL_MISSING_COOLDOWN_MS = 5_000;
const MODEL_PERF_MAX = 16;

const nodeState = new Map<string, NodeState>();
let lastCleanup = 0;

function maybeJitter(cooldownMs: number): number {
  if (cooldownMs <= 0) return cooldownMs;
  const delta = cooldownMs * JITTER_FACTOR;
  return Math.round(cooldownMs + (Math.random() * 2 - 1) * delta);
}

function createState(): NodeState {
  return {
    activeRequests: 0,
    healthScore: HEALTH_INITIAL,
    avgLatencyMs: 0,
    avgTtftMs: 0,
    cooldownUntil: 0,
    cooldownReason: null,
    circuitState: 'closed',
    consecutiveFailures: 0,
    lastTransientFailureAt: 0,
    probeInFlight: false,
    totalRequests: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    lastUsedAt: 0,
    modelCooldowns: new Map(),
    modelPerf: new Map(),
  };
}

export function getNodeState(nodeId: string): NodeState {
  let state = nodeState.get(nodeId);
  if (!state) {
    state = createState();
    nodeState.set(nodeId, state);
  }
  return state;
}

export function peekAvailability(nodeId: string, now: number = Date.now()): 'yes' | 'probe' | 'no' {
  const state = getNodeState(nodeId);
  if (state.cooldownUntil > now) return 'no';
  if (state.circuitState === 'closed') return 'yes';
  if (state.circuitState === 'open') return state.cooldownUntil <= now ? 'probe' : 'no';
  return state.probeInFlight ? 'no' : 'probe';
}

export function acquireSlot(nodeId: string, now: number = Date.now()): boolean {
  const state = getNodeState(nodeId);
  if (peekAvailability(nodeId, now) === 'no') return false;
  if (state.circuitState === 'open' && state.cooldownUntil <= now) {
    state.circuitState = 'half-open';
    state.probeInFlight = true;
  } else if (state.circuitState === 'half-open' && !state.probeInFlight) {
    state.probeInFlight = true;
  }
  state.activeRequests++;
  state.totalRequests++;
  state.lastUsedAt = now;
  maybeCleanup(now);
  return true;
}

export function recordSuccess(nodeId: string, latencyMs: number, model: string, now: number = Date.now()): void {
  const state = releaseAndReturn(nodeId);
  state.totalSuccesses++;
  state.lastTransientFailureAt = 0;
  state.healthScore = Math.min(HEALTH_MAX, state.healthScore + HEALTH_SUCCESS_GAIN);
  state.consecutiveFailures = 0;
  state.avgLatencyMs = state.avgLatencyMs === 0 || typeof latencyMs !== 'number'
    ? Math.max(0, latencyMs || 0)
    : state.avgLatencyMs * (1 - LATENCY_EWMA_ALPHA) + latencyMs * LATENCY_EWMA_ALPHA;
  if (model) updateModelPerf(state, model, { latencyMs }, now);
  recoverFromHalfOpen(state);
}

export function recordTtft(nodeId: string, ttftMs: number, model: string, { source = 'passive' }: { source?: string } = {}): void {
  const state = getNodeState(nodeId);
  const alpha = source === 'probe' ? PROBE_EWMA_ALPHA : LATENCY_EWMA_ALPHA;
  state.avgTtftMs = state.avgTtftMs === 0 || typeof ttftMs !== 'number' || ttftMs < 0
    ? Math.max(0, ttftMs || 0)
    : state.avgTtftMs * (1 - alpha) + ttftMs * alpha;
  if (model) updateModelPerf(state, model, { ttftMs, source });
}

export function getModelPerf(nodeId: string, model: string) {
  return nodeState.get(nodeId)?.modelPerf?.get(model) || null;
}

function updateModelPerf(
  state: NodeState,
  model: string,
  opts: { ttftMs?: number, latencyMs?: number, source?: string } = {},
  now: number = Date.now(),
): void {
  const { ttftMs, latencyMs, source = 'passive' } = opts;
  let entry = state.modelPerf.get(model);
  if (!entry) {
    if (state.modelPerf.size >= MODEL_PERF_MAX) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, value] of state.modelPerf) {
        if (value.lastUsedAt < oldestAt) {
          oldestAt = value.lastUsedAt;
          oldestKey = key;
        }
      }
      if (oldestKey) state.modelPerf.delete(oldestKey);
    }
    entry = {
      avgTtftMs: 0,
      avgLatencyMs: 0,
      lastUsedAt: now,
      ttftSamples: 0,
      passiveSamples: 0,
      probeSamples: 0,
      lastTtftAt: 0,
      lastProbeFailureAt: 0,
    };
    state.modelPerf.set(model, entry);
  }
  entry.lastUsedAt = now;
  if (typeof ttftMs === 'number' && ttftMs >= 0) {
    const alpha = source === 'probe' ? PROBE_EWMA_ALPHA : LATENCY_EWMA_ALPHA;
    entry.lastTtftAt = now;
    entry.ttftSamples++;
    if (source === 'probe') entry.probeSamples++;
    else entry.passiveSamples++;
    entry.avgTtftMs = entry.avgTtftMs === 0
      ? ttftMs
      : entry.avgTtftMs * (1 - alpha) + ttftMs * alpha;
  }
  if (typeof latencyMs === 'number' && latencyMs >= 0) {
    entry.avgLatencyMs = entry.avgLatencyMs === 0
      ? latencyMs
      : entry.avgLatencyMs * (1 - LATENCY_EWMA_ALPHA) + latencyMs * LATENCY_EWMA_ALPHA;
  }
}

export function markProbeFailure(nodeId: string, model: string, now: number = Date.now()): void {
  const entry = getNodeState(nodeId).modelPerf.get(model);
  if (entry) entry.lastProbeFailureAt = now;
}

export function recordFailure(
  nodeId: string,
  { counted = false, cooldownMs = 0, reason = null }: { counted?: boolean, cooldownMs?: number, reason?: string | null } = {},
  now: number = Date.now(),
): void {
  const state = releaseAndReturn(nodeId);
  state.totalFailures++;
  if (cooldownMs > 0) {
    state.cooldownUntil = now + maybeJitter(cooldownMs);
    state.cooldownReason = reason;
  }
  state.consecutiveFailures = counted ? state.consecutiveFailures + 1 : 0;
  if (counted) state.lastTransientFailureAt = now;

  if (!counted) {
    recoverFromHalfOpen(state);
    return;
  }
  if (state.circuitState === 'half-open') {
    openCircuit(state, now);
    return;
  }
  if (state.circuitState === 'closed' && state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    openCircuit(state, now);
  }
}

export function recordNeutralEnd(nodeId: string): void {
  const state = releaseAndReturn(nodeId);
  recoverFromHalfOpen(state);
}

export function recordModelMissing(
  nodeId: string,
  model: string,
  cooldownMs: number = MODEL_MISSING_COOLDOWN_MS,
  now: number = Date.now(),
): void {
  const state = releaseAndReturn(nodeId);
  if (cooldownMs > 0) state.modelCooldowns.set(model, now + cooldownMs);
  recoverFromHalfOpen(state);
}

export function isModelCooling(nodeId: string, model: string, now: number = Date.now()): boolean {
  const until = nodeState.get(nodeId)?.modelCooldowns?.get(model);
  return Boolean(until && until > now);
}

export function getModelCooldownRemainingMs(nodeId: string, model: string, now: number = Date.now()): number {
  const until = nodeState.get(nodeId)?.modelCooldowns?.get(model);
  return until && until > now ? until - now : 0;
}

function releaseAndReturn(nodeId: string): NodeState {
  const state = getNodeState(nodeId);
  state.activeRequests = Math.max(0, state.activeRequests - 1);
  return state;
}

function openCircuit(state: NodeState, now: number): void {
  state.circuitState = 'open';
  state.probeInFlight = false;
  state.cooldownUntil = now + CIRCUIT_OPEN_MS;
  state.cooldownReason = `circuit_open_after_${CIRCUIT_FAILURE_THRESHOLD}_failures`;
}

function recoverFromHalfOpen(state: NodeState): void {
  if (state.circuitState === 'half-open' || state.probeInFlight) {
    state.circuitState = 'closed';
    state.probeInFlight = false;
    state.consecutiveFailures = 0;
  }
}

const PENALTY: Record<string, number> = {
  rate_limit: 10,
  auth: 30,
  server: 20,
  network: 12,
  stream: 12,
  client: 0,
};

export function applyHealthPenalty(nodeId: string, kind: string): void {
  const state = getNodeState(nodeId);
  state.healthScore = Math.max(HEALTH_MIN, state.healthScore - (PENALTY[kind] ?? 8));
}

export function bumpNodeCounters(
  nodeId: string,
  { requests = 0, successes = 0, failures = 0 }: { requests?: number, successes?: number, failures?: number } = {},
  now: number = Date.now(),
): void {
  const state = getNodeState(nodeId);
  if (requests) {
    state.totalRequests += requests;
    state.lastUsedAt = now;
  }
  if (successes) state.totalSuccesses += successes;
  if (failures) state.totalFailures += failures;
}

function maybeCleanup(now: number): void {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [, state] of nodeState) {
    if (state.cooldownUntil > 0 && state.cooldownUntil <= now) {
      state.cooldownUntil = 0;
      state.cooldownReason = null;
      state.healthScore = Math.min(HEALTH_MAX, state.healthScore + HEALTH_COOLDOWN_RECOVERY);
    }
    for (const [model, until] of state.modelCooldowns) {
      if (until <= now) state.modelCooldowns.delete(model);
    }
    if (state.activeRequests === 0 && state.consecutiveFailures > 0 && now - state.lastUsedAt > STALE_FAILURE_MS) {
      state.consecutiveFailures = 0;
    }
  }
  if (nodeState.size > MAX_STATE_ENTRIES) {
    const entries = [...nodeState.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    const target = Math.floor(MAX_STATE_ENTRIES * 0.75);
    const excess = nodeState.size - target;
    let deleted = 0;
    for (const [id, state] of entries) {
      if (deleted >= excess) break;
      if (state.activeRequests > 0 || state.probeInFlight) continue;
      nodeState.delete(id);
      deleted++;
    }
  }
}

export function getCooldownRemainingMs(nodeId: string, now: number = Date.now()): number {
  const state = getNodeState(nodeId);
  return state.cooldownUntil > now ? state.cooldownUntil - now : 0;
}

export function snapshotNode(nodeId: string, now: number = Date.now()) {
  const state = getNodeState(nodeId);
  const cooling = state.cooldownUntil > now;
  return {
    health_score: Math.round(state.healthScore),
    status: cooling ? 'cooling_down' : 'active',
    cooldown_remaining_ms: cooling ? state.cooldownUntil - now : 0,
    cooldown_reason: cooling ? state.cooldownReason : null,
    circuit_state: state.circuitState,
    active_requests: state.activeRequests,
    consecutive_failures: state.consecutiveFailures,
    avg_latency_ms: Math.round(state.avgLatencyMs),
    avg_ttft_ms: Math.round(state.avgTtftMs),
    total_requests: state.totalRequests,
    total_successes: state.totalSuccesses,
    total_failures: state.totalFailures,
    last_used_at: state.lastUsedAt > 0 ? new Date(state.lastUsedAt).toISOString() : null,
  };
}

export function hasBeenObserved(nodeId: string): boolean {
  const state = nodeState.get(nodeId);
  return Boolean(state && state.totalSuccesses > 0);
}

export function __resetAllStateForTests(): void {
  nodeState.clear();
  lastCleanup = 0;
}
