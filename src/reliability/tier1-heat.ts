// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Tier 1 heat protection. This layer does not create a new quota system and
// never turns soft pressure into a primary-request hard block. It only gives
// P2C a small early signal before the existing concurrency/RPM gates are hit,
// weakens affinity as an account gets hot, and keeps hedge twins away from
// accounts with little spare capacity.

import { tier1AccountInFlight, tier1RpmUsage } from './tier1-state.ts';
import type { RuntimeNode } from '../types/node.ts';

export const TIER1_RPM_HEADROOM_MAX_FACTOR = 1.20;
export const TIER1_HEDGE_MAX_RPM_PRESSURE = 0.50;
export const TIER1_HEDGE_MAX_CONCURRENCY_PRESSURE = 0.75;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

// Keep this in lock-step with tier1-state's deliberately tiny smooth-RPM
// bucket. Capacity <= 1 has no useful pre-block headroom interval, so it stays
// neutral here and relies on the existing hard admission gate.
function rpmBurstCapacity(rpm: number): number {
  return Math.max(1, Math.min(2, Math.floor(rpm)));
}

export function tier1RpmHeadroomPressure(node: RuntimeNode, now: number = Date.now()): number {
  const rpm = node?.limits?.rpm ?? 0;
  if (!Number.isFinite(rpm) || rpm <= 0 || node?.limits?.rpmMode === 'soft') return 0;
  const capacity = rpmBurstCapacity(rpm);
  if (capacity <= 1) return 0;

  // tier1RpmUsage is the current token deficit. With capacity=2, an unused
  // bucket is 0 and an account with only the final dispatchable token left is
  // 1. This gives P2C a smooth 0..1 pressure signal before the hard gate.
  const usage = tier1RpmUsage(node.id, now);
  return clamp01(usage / (capacity - 1));
}

export function tier1ConcurrencyPressure(node: RuntimeNode): number {
  const capacity = node?.limits?.concurrency ?? 0;
  if (!Number.isFinite(capacity) || capacity <= 0) return 0;
  return clamp01(tier1AccountInFlight(node.id) / capacity);
}

export function tier1HeatPressure(node: RuntimeNode, now: number = Date.now()): number {
  return Math.max(
    tier1RpmHeadroomPressure(node, now),
    tier1ConcurrencyPressure(node),
  );
}

// A hot account gets at most a 20% score penalty from RPM headroom. The
// existing loadFactor continues to own concurrency scoring, avoiding double
// punishment for in-flight pressure.
export function tier1RpmHeadroomFactor(node: RuntimeNode, now: number = Date.now()): number {
  const pressure = tier1RpmHeadroomPressure(node, now);
  return 1 + (TIER1_RPM_HEADROOM_MAX_FACTOR - 1) * pressure;
}

// Affinity is advisory. At zero heat the existing bias is preserved; as heat
// approaches 1 the bias decays linearly to neutral (1.0). It never becomes a
// penalty by itself.
export function tier1AffinityHeatFactor(
  node: RuntimeNode,
  baseAffinityFactor: number,
  now: number = Date.now(),
): number {
  if (!Number.isFinite(baseAffinityFactor) || baseAffinityFactor >= 1) return 1;
  const pressure = tier1HeatPressure(node, now);
  return baseAffinityFactor + (1 - baseAffinityFactor) * pressure;
}

// Single multiplier passed into calculateTier1Score. RPM pressure applies to
// every candidate; affinity decay only affects the bound account.
export function tier1SelectionHeatFactor(
  node: RuntimeNode,
  baseAffinityFactor: number,
  now: number = Date.now(),
): number {
  return tier1RpmHeadroomFactor(node, now)
    * tier1AffinityHeatFactor(node, baseAffinityFactor, now);
}

// Hedge twins are optional latency work, so require visible spare capacity.
// Primary requests remain governed only by the existing eligibility/admission
// rules and are never rejected by these soft thresholds.
export function tier1CanAcceptHedge(node: RuntimeNode, now: number = Date.now()): boolean {
  return tier1RpmHeadroomPressure(node, now) <= TIER1_HEDGE_MAX_RPM_PRESSURE
    && tier1ConcurrencyPressure(node) < TIER1_HEDGE_MAX_CONCURRENCY_PRESSURE;
}
