// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Tier 1 heat protection. This layer does not create a new quota system and
// never turns soft pressure into a primary-request hard block. It gives P2C
// bounded live-load signals, weakens affinity as an account gets hot, and keeps
// hedge twins away from already-busy accounts.
//
// Operator-supplied limits.concurrency is intentionally NOT used. Free-provider
// concurrency is often unknown, so active in-flight work is treated as a soft
// relative pressure signal rather than a guessed hard ceiling.

import { tier1AccountInFlight, tier1RpmUsage } from './tier1-state.ts';
import type { RuntimeNode } from '../types/node.ts';

export const TIER1_RPM_HEADROOM_MAX_FACTOR = 1.20;
export const TIER1_INFLIGHT_MAX_FACTOR = 1.25;
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
  const inFlight = tier1AccountInFlight(node.id);
  if (!Number.isFinite(inFlight) || inFlight <= 0) return 0;
  // No guessed capacity denominator. Pressure rises smoothly with live work:
  // 1 -> .33, 2 -> .50, 4 -> .67, 6 -> .75. It never blocks a primary.
  return clamp01(inFlight / (inFlight + 2));
}

export function tier1HeatPressure(node: RuntimeNode, now: number = Date.now()): number {
  return Math.max(
    tier1RpmHeadroomPressure(node, now),
    tier1ConcurrencyPressure(node),
  );
}

// A hot account gets at most a 20% score penalty from RPM headroom. The
// existing hard RPM gate remains authoritative when an operator configured it.
export function tier1RpmHeadroomFactor(node: RuntimeNode, now: number = Date.now()): number {
  const pressure = tier1RpmHeadroomPressure(node, now);
  return 1 + (TIER1_RPM_HEADROOM_MAX_FACTOR - 1) * pressure;
}

// Live in-flight work is ranking-only: a busy account can be demoted by at most
// 25%, but it remains eligible and can still win when peers are worse or absent.
export function tier1InFlightFactor(node: RuntimeNode): number {
  const pressure = tier1ConcurrencyPressure(node);
  return 1 + (TIER1_INFLIGHT_MAX_FACTOR - 1) * pressure;
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

// Single multiplier passed into calculateTier1Score. RPM pressure and live
// in-flight pressure apply to every candidate; affinity decay only affects the
// bound account. All three are soft ranking effects.
export function tier1SelectionHeatFactor(
  node: RuntimeNode,
  baseAffinityFactor: number,
  now: number = Date.now(),
): number {
  return tier1RpmHeadroomFactor(node, now)
    * tier1InFlightFactor(node)
    * tier1AffinityHeatFactor(node, baseAffinityFactor, now);
}

// Hedge twins are optional latency work, so require visible spare capacity.
// Primary requests remain governed only by normal eligibility/admission rules
// and are never rejected by these soft thresholds.
export function tier1CanAcceptHedge(node: RuntimeNode, now: number = Date.now()): boolean {
  return tier1RpmHeadroomPressure(node, now) <= TIER1_HEDGE_MAX_RPM_PRESSURE
    && tier1ConcurrencyPressure(node) < TIER1_HEDGE_MAX_CONCURRENCY_PRESSURE;
}
