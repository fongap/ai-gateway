// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Tier Execution Loop helpers. Tier order is a product invariant:
// Tier 1 (free capacity) -> Tier 2 (subscription entitlement reserve)
// -> Tier 3 (paid API reserve). Attempt allocation therefore has one explicit
// precedence model; lower-tier node counts never pull surplus budget away from
// a higher tier.

import { TIER_ORDER } from './router.ts';
import { pickCandidate, tierHasDispatchableNode, countDispatchableNodes } from '../scheduler/scheduler.ts';
import { pickTier1Candidate } from '../scheduler/tier1-scheduler.ts';
import { tier1HasDispatchableNode, tier1CountDispatchableNodes } from '../reliability/tier1-state.ts';
import type { Tier, RoutableRequest } from '../types/scheduler.ts';
import type { RuntimeNode } from '../types/node.ts';
import type { PolicyConfig } from '../types/policy.ts';

function tier1Dispatchable(
  nodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  attempted: Set<string>,
  now: number,
  knownModels: ReadonlySet<string>,
  maxInFlight?: number | null,
): boolean {
  return tier1HasDispatchableNode(nodes, req, attempted, now, knownModels, maxInFlight);
}

function tier1LiveCount(
  nodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  attempted: Set<string>,
  now: number,
  knownModels: ReadonlySet<string>,
  maxInFlight?: number | null,
): number {
  return tier1CountDispatchableNodes(nodes, req, attempted, now, knownModels, maxInFlight);
}

export type TierPickResult = {
  node?: RuntimeNode,
  raceLost?: boolean,
  raceLostNodeId?: string,
  tier1ReleaseToken?: { accountId: string, released: boolean } | null,
  tier1EscapedFromAffinity?: boolean,
  tier1UpdateAffinity?: boolean,
  tier1AffinityHit?: boolean,
} | null;

type PickForTierOpts = {
  knownModels?: ReadonlySet<string> | null,
  affinityAccountId?: string | null,
  evaluateAffinity?: boolean,
  now?: number,
  rng?: () => number,
  excludeId?: string | null,
  raceLostIds?: Set<string> | null,
  maxInFlight?: number | null,
};

export function pickForTier(
  tierNumber: Tier,
  tierNodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  attempted: Set<string>,
  opts: PickForTierOpts = {},
): TierPickResult {
  const { knownModels, raceLostIds, maxInFlight } = opts;
  if (tierNumber !== 1) {
    const r = pickCandidate(tierNodes, req, attempted, undefined, null, knownModels, raceLostIds ?? null);
    if (!r) return null;
    if (r.raceLost) return { raceLost: true, raceLostNodeId: r.raceLostNodeId };
    return { node: r.node };
  }
  const r = pickTier1Candidate(tierNodes, req, attempted, { ...opts, knownModels, maxInFlight });
  if (!r) return null;
  if (r.raceLost) return { raceLost: true, raceLostNodeId: r.raceLostNodeId };
  return {
    node: r.node,
    tier1ReleaseToken: r.releaseToken,
    tier1EscapedFromAffinity: r.escapedFromAffinity,
    tier1UpdateAffinity: r.updateAffinity,
    tier1AffinityHit: r.affinityHit,
  };
}

// Mulberry32 is used only when TIER1_SCHEDULER_SEED is set for deterministic
// tests. Production leaves it unset and uses Math.random.
export function makeTier1Rng(env: Record<string, unknown>): () => number {
  const seedRaw = String(env?.TIER1_SCHEDULER_SEED ?? '').trim();
  if (!seedRaw) return Math.random;
  let h = 1779033703 ^ seedRaw.length;
  for (let i = 0; i < seedRaw.length; i++) {
    h = Math.imul(h ^ seedRaw.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One allocation model only:
//
// - a tier with no dispatchable candidate gets 0;
// - explicit tier_attempts values are hard caps and are reserved first;
// - an explicit 0 disables that tier;
// - each remaining dispatchable tier gets a one-attempt baseline while budget
//   permits, in strict Tier 1 -> Tier 2 -> Tier 3 order;
// - every remaining surplus attempt goes to the FIRST adjustable dispatchable
//   tier, preserving the product's free -> subscription -> paid precedence.
//
// There is deliberately no weighted/live-node cross-tier splitter. Candidate
// count influences selection INSIDE a tier, never the tier hierarchy itself.
export function computeTierCaps(
  tiers: Record<number, RuntimeNode[]>,
  reqDescriptor: RoutableRequest,
  attempted: Set<string>,
  policy: PolicyConfig,
  knownModels: ReadonlySet<string>,
  maxInFlight?: number | null,
): Record<number, number> {
  const now = Date.now();
  const caps: Record<number, number> = {};
  for (const t of TIER_ORDER) caps[t] = 0;

  const dispatchable = TIER_ORDER.filter((t) =>
    t === 1
      ? tier1Dispatchable(tiers[t], reqDescriptor, attempted, now, knownModels, maxInFlight)
      : tierHasDispatchableNode(tiers[t], reqDescriptor, attempted, now, knownModels));
  if (dispatchable.length === 0) return caps;

  const max = policy.maxAttempts;
  const explicitTotal = TIER_ORDER.reduce((sum, t) =>
    sum + (policy.tierAttempts?.[`tier${t}`] ?? 0), 0);
  const adjustable = dispatchable.filter((t) =>
    policy.tierAttempts?.[`tier${t}`] === undefined);

  for (const t of dispatchable) {
    const override = policy.tierAttempts?.[`tier${t}`];
    if (override !== undefined) caps[t] = override;
  }

  if (adjustable.length === 0) return caps;
  const remaining = Math.max(0, max - explicitTotal);
  if (remaining === 0) return caps;

  const baselineCount = Math.min(remaining, adjustable.length);
  for (let i = 0; i < baselineCount; i++) caps[adjustable[i]] = 1;
  if (remaining > baselineCount) caps[adjustable[0]] += remaining - baselineCount;
  return caps;
}

// Number of dispatches that can still happen in the current model/protocol pass.
// This is recomputed before every attempt because availability can change while
// a request is in flight. It observes tier caps; it does not redistribute them.
export function countRemainingDispatchableAttempts(
  tiers: Record<number, RuntimeNode[]>,
  reqDescriptor: RoutableRequest,
  attempted: Set<string>,
  tierCaps: Record<number, number>,
  currentTier: Tier,
  usedInTier: number,
  sharedRemaining: number,
  knownModels: ReadonlySet<string>,
  maxInFlight?: number | null,
): number {
  const now = Date.now();
  let total = 0;
  let currentReached = false;
  for (const tierNumber of TIER_ORDER) {
    if (tierNumber === currentTier) currentReached = true;
    if (!currentReached) continue;
    const capRemaining = Math.max(0,
      (tierCaps[tierNumber] ?? 0) - (tierNumber === currentTier ? usedInTier : 0));
    if (capRemaining === 0) continue;
    const live = tierNumber === 1
      ? tier1LiveCount(tiers[tierNumber], reqDescriptor, attempted, now, knownModels, maxInFlight)
      : countDispatchableNodes(tiers[tierNumber], reqDescriptor, attempted, now, knownModels);
    total += Math.min(capRemaining, live);
  }
  return Math.max(1, Math.min(Math.max(1, sharedRemaining), total || 1));
}
