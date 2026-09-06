// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Isolate-local node runtime state. Module successor of the ambient
// declarations in src/types/domain.d.ts (see src/types/protocol.ts header
// for the transition plan). Shapes mirror what node-state.ts actually
// creates and mutates (createState / updateModelPerf), not the stale
// typedef comments that used to live in domain.d.ts.

export type ModelPerfEntry = {
  avgTtftMs: number,
  avgLatencyMs: number,
  lastUsedAt: number,
  ttftSamples: number,
  passiveSamples: number,
  probeSamples: number,
  lastTtftAt: number,
  lastProbeFailureAt: number,
};

export type CircuitState = 'closed' | 'open' | 'half-open';

export type NodeState = {
  activeRequests: number,
  healthScore: number,
  avgLatencyMs: number,
  avgTtftMs: number,
  cooldownUntil: number,
  cooldownReason: string | null,
  circuitState: CircuitState,
  consecutiveFailures: number,
  lastTransientFailureAt: number,
  probeInFlight: boolean,
  totalRequests: number,
  totalSuccesses: number,
  totalFailures: number,
  lastUsedAt: number,
  /** Per-logical-model model_missing cooldown deadline (ms epoch). */
  modelCooldowns: Map<string, number>,
  /** Per-logical-model performance EWMA, bounded LRU by lastUsedAt. */
  modelPerf: Map<string, ModelPerfEntry>,
};
