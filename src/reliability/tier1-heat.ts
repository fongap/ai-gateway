// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Tier 1 soft heat protection. No guessed node capacity exists: live in-flight
// work weakens affinity/ranking and suppresses optional hedge twins, while real
// primary traffic always remains eligible unless reliability state blocks it.

import { tier1AccountInFlight } from './tier1-state.ts';
import type { RuntimeNode } from '../types/node.ts';

export const TIER1_INFLIGHT_MAX_FACTOR = 1.25;
export const TIER1_HEDGE_MAX_CONCURRENCY_PRESSURE = 0.75;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function tier1ConcurrencyPressure(node: RuntimeNode): number {
  const inFlight = tier1AccountInFlight(node.id);
  if (!Number.isFinite(inFlight) || inFlight <= 0) return 0;
  // 1 -> .50, 2 -> .67, 3 -> .75, 4 -> .80. Ranking only.
  return clamp01(inFlight / (inFlight + 1));
}

export function tier1HeatPressure(node: RuntimeNode): number {
  return tier1ConcurrencyPressure(node);
}

export function tier1InFlightFactor(node: RuntimeNode): number {
  const pressure = tier1ConcurrencyPressure(node);
  return 1 + (TIER1_INFLIGHT_MAX_FACTOR - 1) * pressure;
}

export function tier1AffinityHeatFactor(node: RuntimeNode, baseAffinityFactor: number): number {
  if (!Number.isFinite(baseAffinityFactor) || baseAffinityFactor >= 1) return 1;
  const pressure = tier1HeatPressure(node);
  return baseAffinityFactor + (1 - baseAffinityFactor) * pressure;
}

export function tier1SelectionHeatFactor(node: RuntimeNode, baseAffinityFactor: number): number {
  return tier1InFlightFactor(node) * tier1AffinityHeatFactor(node, baseAffinityFactor);
}

export function tier1CanAcceptHedge(node: RuntimeNode): boolean {
  return tier1ConcurrencyPressure(node) < TIER1_HEDGE_MAX_CONCURRENCY_PRESSURE;
}
