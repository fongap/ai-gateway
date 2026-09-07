// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Isolate-local node runtime state. Canonical source for CircuitState,
// ModelPerfEntry, and NodeState, consumed by the reliability layer.
// Shapes mirror what node-state.ts actually creates and mutates
// (createState / updateModelPerf) (src/types/domain.d.ts has been deleted —
// see docs/governance/typescript-migration.md).

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
