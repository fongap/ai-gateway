// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Dynamic Tier 2/3 candidate selection. Capacity is inferred from runtime
// state; there are no operator-guessed node RPM/concurrency admission gates.

import { peekAvailability, acquireSlot, getNodeState, isModelCooling, getModelPerf } from '../reliability/node-state.ts';
import { servesModel } from '../config/registry.ts';
import type { RuntimeNode } from '../types/node.ts';
import type { RoutableRequest, PickedCandidate } from '../types/scheduler.ts';
import type { NodeState, ModelPerfEntry } from '../types/reliability.ts';

export function supportsRequest(node: RuntimeNode, req: RoutableRequest, knownModels?: ReadonlySet<string> | null): boolean {
  if (!req || typeof req !== 'object') return false;
  if (node.protocol !== req.protocol) return false;
  if (!Array.isArray(node.surfaces) || !node.surfaces.includes(req.surface)) return false;
  return servesModel(node, req.model, knownModels);
}

export function pickCandidate(
  tierNodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  attempted: Set<string>,
  now: number = Date.now(),
  excludeId: string | null = null,
  knownModels?: ReadonlySet<string> | null,
  excludeIds?: ReadonlySet<string> | null,
): PickedCandidate | null {
  let best: RuntimeNode | null = null;
  let bestState: NodeState | null = null;

  for (const node of tierNodes) {
    if (node.id === excludeId || excludeIds?.has(node.id) || attempted.has(node.id)) continue;
    if (!supportsRequest(node, req, knownModels)) continue;
    if (peekAvailability(node.id, now) === 'no') continue;
    if (isModelCooling(node.id, req.model, now)) continue;
    const s = getNodeState(node.id);
    if (!best || betterThan(s, node, bestState as NodeState, best, req.model, now)) {
      best = node;
      bestState = s;
    }
  }

  if (!best) return null;
  if (!acquireSlot(best.id, now)) return { raceLost: true, raceLostNodeId: best.id };
  return { node: best };
}

export function tierHasDispatchableNode(
  tierNodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  attempted: Set<string>,
  now: number = Date.now(),
  knownModels?: ReadonlySet<string> | null,
): boolean {
  return countDispatchableNodes(tierNodes, req, attempted, now, knownModels) > 0;
}

export function countDispatchableNodes(
  tierNodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  attempted: Set<string>,
  now: number = Date.now(),
  knownModels?: ReadonlySet<string> | null,
): number {
  let count = 0;
  for (const node of tierNodes) {
    if (attempted.has(node.id)) continue;
    if (!supportsRequest(node, req, knownModels)) continue;
    if (peekAvailability(node.id, now) === 'no') continue;
    if (isModelCooling(node.id, req.model, now)) continue;
    count++;
  }
  return count;
}

const HEALTH_TIE_BAND = 10;
const LATENCY_ADVANTAGE_FACTOR = 1.5;
const TRANSIENT_FAILURE_PREFERENCE_MS = 5_000;
const STALE_TTFT_MS = 5 * 60_000;
const QUALITY_TTFT_MS = 15 * 60_000;
const MIN_QUALITY_SAMPLES = 3;

function effectiveTtft(perf: ModelPerfEntry | null, nodeLevelTtft: number, now: number): number {
  if (!perf) return nodeLevelTtft;
  if (perf.lastTtftAt > 0) {
    const ttl = perf.passiveSamples >= MIN_QUALITY_SAMPLES ? QUALITY_TTFT_MS : STALE_TTFT_MS;
    if (now - perf.lastTtftAt > ttl) return 0;
  }
  if (perf.lastProbeFailureAt > perf.lastTtftAt) return 0;
  if (perf.passiveSamples === 0 && perf.probeSamples > 0) return 0;
  return perf.avgTtftMs;
}

function latencyPreference(
  a: NodeState,
  aNode: RuntimeNode,
  b: NodeState,
  bNode: RuntimeNode,
  model: string,
  now: number,
): boolean | null {
  const aPerf = model ? getModelPerf(aNode.id, model) : null;
  const bPerf = model ? getModelPerf(bNode.id, model) : null;
  const aTtft = effectiveTtft(aPerf, a.avgTtftMs, now);
  const bTtft = effectiveTtft(bPerf, b.avgTtftMs, now);
  if (aTtft > 0 && bTtft > 0) {
    if (aTtft <= bTtft / LATENCY_ADVANTAGE_FACTOR) return true;
    if (bTtft <= aTtft / LATENCY_ADVANTAGE_FACTOR) return false;
    return null;
  }
  const aLat = aPerf?.avgLatencyMs || a.avgLatencyMs;
  const bLat = bPerf?.avgLatencyMs || b.avgLatencyMs;
  if (aLat > 0 && bLat > 0) {
    if (aLat <= bLat / LATENCY_ADVANTAGE_FACTOR) return true;
    if (bLat <= aLat / LATENCY_ADVANTAGE_FACTOR) return false;
  }
  return null;
}

function betterThan(a: NodeState, aNode: RuntimeNode, b: NodeState, bNode: RuntimeNode, model: string, now: number): boolean {
  const aRecentlyFailed = a.lastTransientFailureAt > 0
    && now - a.lastTransientFailureAt < TRANSIENT_FAILURE_PREFERENCE_MS;
  const bRecentlyFailed = b.lastTransientFailureAt > 0
    && now - b.lastTransientFailureAt < TRANSIENT_FAILURE_PREFERENCE_MS;
  if (aRecentlyFailed !== bRecentlyFailed) return !aRecentlyFailed;
  // Static priority intentionally exists only for Tier 2/3. Tier 1 uses live
  // P2C signals and never consults RuntimeNode.priority.
  if (aNode.priority !== bNode.priority) return aNode.priority < bNode.priority;
  if (a.activeRequests !== b.activeRequests) return a.activeRequests < b.activeRequests;
  if (Math.abs(a.healthScore - b.healthScore) >= HEALTH_TIE_BAND) return a.healthScore > b.healthScore;
  const preference = latencyPreference(a, aNode, b, bNode, model, now);
  if (preference !== null) return preference;
  if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt < b.lastUsedAt;
  return a.avgLatencyMs < b.avgLatencyMs;
}
