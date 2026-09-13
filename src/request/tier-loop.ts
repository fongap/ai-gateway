// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Tier execution helpers. Candidate capacity is always derived from live
// runtime state; no configured node RPM/concurrency limit participates here.

import { TIER_ORDER } from './router.ts';
import { pickCandidate, tierHasDispatchableNode, countDispatchableNodes } from '../scheduler/scheduler.ts';
import { pickTier1Candidate } from '../scheduler/tier1-scheduler.ts';
import { tier1HasDispatchableNode, tier1CountDispatchableNodes } from '../reliability/tier1-state.ts';
import type { Tier, RoutableRequest } from '../types/scheduler.ts';
import type { RuntimeNode } from '../types/node.ts';
import type { PolicyConfig } from '../types/policy.ts';

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
};

export function pickForTier(
  tierNumber: Tier,
  tierNodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  attempted: Set<string>,
  opts: PickForTierOpts = {},
): TierPickResult {
  const { knownModels, raceLostIds } = opts;
  if (tierNumber !== 1) {
    const result = pickCandidate(tierNodes, req, attempted, undefined, null, knownModels, raceLostIds ?? null);
    if (!result) return null;
    if (result.raceLost) return { raceLost: true, raceLostNodeId: result.raceLostNodeId };
    return { node: result.node };
  }
  const result = pickTier1Candidate(tierNodes, req, attempted, { ...opts, knownModels });
  if (!result) return null;
  if (result.raceLost) return { raceLost: true, raceLostNodeId: result.raceLostNodeId };
  return {
    node: result.node,
    tier1ReleaseToken: result.releaseToken,
    tier1EscapedFromAffinity: result.escapedFromAffinity,
    tier1UpdateAffinity: result.updateAffinity,
    tier1AffinityHit: result.affinityHit,
  };
}

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

export function computeTierCaps(
  tiers: Record<number, RuntimeNode[]>,
  reqDescriptor: RoutableRequest,
  attempted: Set<string>,
  policy: PolicyConfig,
  knownModels: ReadonlySet<string>,
): Record<number, number> {
  const now = Date.now();
  const caps: Record<number, number> = {};
  for (const tier of TIER_ORDER) caps[tier] = 0;
  const dispatchable = TIER_ORDER.filter((tier) =>
    tier === 1
      ? tier1HasDispatchableNode(tiers[tier], reqDescriptor, attempted, now, knownModels)
      : tierHasDispatchableNode(tiers[tier], reqDescriptor, attempted, now, knownModels));
  if (dispatchable.length === 0) return caps;

  const max = policy.maxAttempts;
  const explicitTotal = TIER_ORDER.reduce(
    (sum, tier) => sum + (policy.tierAttempts?.[`tier${tier}`] ?? 0),
    0,
  );
  const hasExplicit = TIER_ORDER.some((tier) => policy.tierAttempts?.[`tier${tier}`] !== undefined);
  const adjustable = dispatchable.filter((tier) => policy.tierAttempts?.[`tier${tier}`] === undefined);

  for (const tier of dispatchable) {
    const override = policy.tierAttempts?.[`tier${tier}`];
    if (override !== undefined) caps[tier] = override;
  }

  const liveCount = (tierNumber: number): number => tierNumber === 1
    ? tier1CountDispatchableNodes(tiers[tierNumber], reqDescriptor, attempted, now, knownModels)
    : countDispatchableNodes(tiers[tierNumber], reqDescriptor, attempted, now, knownModels);

  if (policy.budgetSplit === 'weighted') {
    if (adjustable.length === 0) return caps;
    const remaining = Math.max(0, max - explicitTotal);
    if (remaining === 0) return caps;
    const totalLive = adjustable.reduce((sum, tier) => sum + liveCount(tier), 0);
    if (totalLive === 0) return caps;

    const baselineCount = Math.min(remaining, adjustable.length);
    for (let i = 0; i < baselineCount; i++) caps[adjustable[i]] = 1;
    if (remaining <= baselineCount) return caps;

    const surplus = remaining - baselineCount;
    adjustable.forEach((tier, index) => {
      const baseline = index < baselineCount ? 1 : 0;
      caps[tier] = baseline + Math.floor(surplus * (liveCount(tier) / totalLive));
    });
    const used = adjustable.reduce((sum, tier) => sum + caps[tier], 0);
    const remainder = remaining - used;
    if (remainder > 0) caps[adjustable[adjustable.length - 1]] += remainder;
    return caps;
  }

  if (!hasExplicit) {
    const surplus = Math.max(0, max - dispatchable.length);
    dispatchable.forEach((tier, index) => {
      caps[tier] = index === 0 ? 1 + surplus : 1;
    });
    return caps;
  }

  if (adjustable.length === 0) return caps;
  const remaining = Math.max(0, max - explicitTotal);
  if (remaining === 0) return caps;
  const baselineCount = Math.min(remaining, adjustable.length);
  for (let i = 0; i < baselineCount; i++) caps[adjustable[i]] = 1;
  if (remaining > baselineCount) caps[adjustable[0]] += remaining - baselineCount;
  return caps;
}

export function countRemainingDispatchableAttempts(
  tiers: Record<number, RuntimeNode[]>,
  reqDescriptor: RoutableRequest,
  attempted: Set<string>,
  tierCaps: Record<number, number>,
  currentTier: Tier,
  usedInTier: number,
  sharedRemaining: number,
  knownModels: ReadonlySet<string>,
): number {
  const now = Date.now();
  let total = 0;
  let currentReached = false;
  for (const tierNumber of TIER_ORDER) {
    if (tierNumber === currentTier) currentReached = true;
    if (!currentReached) continue;
    const capRemaining = Math.max(
      0,
      (tierCaps[tierNumber] ?? 0) - (tierNumber === currentTier ? usedInTier : 0),
    );
    if (capRemaining === 0) continue;
    const live = tierNumber === 1
      ? tier1CountDispatchableNodes(tiers[tierNumber], reqDescriptor, attempted, now, knownModels)
      : countDispatchableNodes(tiers[tierNumber], reqDescriptor, attempted, now, knownModels);
    total += Math.min(capRemaining, live);
  }
  return Math.max(1, Math.min(Math.max(1, sharedRemaining), total || 1));
}
