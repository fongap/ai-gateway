// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Tier 1 live-load protection. Static RPM/concurrency limits do not exist.
// In-flight work is a soft signal: it weakens affinity and prevents optional
// hedge twins from piling onto already-busy accounts; primary requests remain
// eligible and are never hard-blocked by this module.

import { tier1AccountInFlight } from './tier1-state.ts';
import type { RuntimeNode } from '../types/node.ts';

export const TIER1_HEDGE_MAX_CONCURRENCY_PRESSURE = 0.75;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function tier1ConcurrencyPressure(node: RuntimeNode): number {
  const inFlight = tier1AccountInFlight(node.id);
  if (!Number.isFinite(inFlight) || inFlight <= 0) return 0;
  return clamp01(inFlight / (inFlight + 1));
}

export function tier1HeatPressure(node: RuntimeNode): number {
  return tier1ConcurrencyPressure(node);
}

// Affinity is advisory. At zero heat the configured bias is preserved; as
// live pressure approaches 1 it decays to neutral. The direct in-flight score
// penalty itself is applied once in calculateTier1Score().
export function tier1AffinityHeatFactor(node: RuntimeNode, baseAffinityFactor: number): number {
  if (!Number.isFinite(baseAffinityFactor) || baseAffinityFactor >= 1) return 1;
  const pressure = tier1ConcurrencyPressure(node);
  return baseAffinityFactor + (1 - baseAffinityFactor) * pressure;
}

export function tier1SelectionHeatFactor(node: RuntimeNode, baseAffinityFactor: number): number {
  return tier1AffinityHeatFactor(node, baseAffinityFactor);
}

export function tier1CanAcceptHedge(node: RuntimeNode): boolean {
  return tier1ConcurrencyPressure(node) < TIER1_HEDGE_MAX_CONCURRENCY_PRESSURE;
}
