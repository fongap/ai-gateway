// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Tier Execution Loop — iterates tiers in TIER_ORDER, within each tier
// attempts eligible candidates in priority order, charges logical
// attempts / dispatches / hedges, and returns a terminal Response when
// the request was committed (success, budget exhausted, client-side
// stop) or null when all tiers are exhausted so the caller can fall
// through to cross-protocol fallback or the exhausted handler.
//
// This module owns the pure helpers that compute per-tier budget and
// dispatchable-count. The actual request orchestration stays in handler.ts;
// upstream attempt execution lives in attempt.ts.

import { TIER_ORDER } from './router.ts';
import { pickCandidate, tierHasDispatchableNode, countDispatchableNodes } from '../scheduler/scheduler.ts';
import { pickTier1Candidate } from '../scheduler/tier1-scheduler.ts';
import { tier1HasDispatchableNode, tier1CountDispatchableNodes } from '../reliability/tier1-state.ts';
import type { Tier, RoutableRequest } from '../types/scheduler.ts';
import type { RuntimeNode } from '../types/node.ts';
import type { PolicyConfig } from '../types/policy.ts';

const SOFT_ONLY_CONCURRENCY = Number.MAX_SAFE_INTEGER;

function tier1WithoutHardConcurrency(nodes: ReadonlyArray<RuntimeNode>): RuntimeNode[] {
  return nodes.map((node) => node.limits.concurrency === SOFT_ONLY_CONCURRENCY
    ? node
    : { ...node, limits: { ...node.limits, concurrency: SOFT_ONLY_CONCURRENCY } });
}

function tier1Dispatchable(
  nodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  attempted: Set<string>,
  now: number,
  knownModels: ReadonlySet<string>,
): boolean {
  return tier1HasDispatchableNode(
    tier1WithoutHardConcurrency(nodes), req, attempted, now, knownModels,
  );
}

function tier1LiveCount(
  nodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  attempted: Set<string>,
  now: number,
  knownModels: ReadonlySet<string>,
): number {
  return tier1CountDispatchableNodes(
    tier1WithoutHardConcurrency(nodes), req, attempted, now, knownModels,
  );
}

export type TierPickResult = {
  node?: RuntimeNode,
  raceLost?: boolean,
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

// Tier-aware picker. Tier 1 uses P2C + affinity + tier1-state eligibility;
// Tier 2/3 use node-state pickCandidate. Both paths expose the same
// { node } | { raceLost: true } | null result shape to the tier loop.
// An optional deterministic RNG (from TIER1_SCHEDULER_SEED) makes P2C sampling
// reproducible in tests; when the seed is absent, Math.random is used.
export function pickForTier(tierNumber: Tier, tierNodes: ReadonlyArray<RuntimeNode>, req: RoutableRequest, attempted: Set<string>, opts: PickForTierOpts = {}): TierPickResult {
  const { knownModels, raceLostIds } = opts;
  if (tierNumber !== 1) {
    const r = pickCandidate(tierNodes, req, attempted, undefined, null, knownModels, raceLostIds ?? null);
    if (!r) return null;
    if (r.raceLost) return { raceLost: true };
    return { node: r.node };
  }
  const r = pickTier1Candidate(tierNodes, req, attempted, { ...opts, knownModels });
  if (!r) return null;
  if (r.raceLost) return { raceLost: true };
  return {
    node: r.node,
    tier1ReleaseToken: r.releaseToken,
    tier1EscapedFromAffinity: r.escapedFromAffinity,
    tier1UpdateAffinity: r.updateAffinity,
    tier1AffinityHit: r.affinityHit,
  };
}

// Mulberry32 — a tiny deterministic PRNG for test reproducibility only. It is
// only wired in when env.TIER1_SCHEDULER_SEED is a non-empty string; production
// leaves it unset and P2C uses Math.random.
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
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Per-tier attempt budget: { tier1, tier2, tier3 } -> max attempts each.
//   * DISPATCHABLE means a candidate this tier can launch now. Deferred
//     capacity (cooldown / over-quota) feeds Retry-After and diagnostics but
//     receives no attempt budget. Guessed concurrency is never a hard gate.
//   * A tier with no dispatchable candidate for the request descriptor gets 0
//     budget.
//   * Explicit `tier_attempts` values are fixed caps. Their configured total is
//     reserved first; remaining budget may only be assigned to dispatchable
//     tiers without an explicit value. An explicit 0 disables that tier.
//   * `even` gives the first adjustable tier the available surplus.
//   * `weighted` distributes adjustable budget according to each tier's live
//     dispatchable node count.
// Budget is a per-tier upper bound; the shared state.maxAttempts still caps the
// request's total upstream attempts, and FAILOVER_BUDGET_MS caps wall-clock.
export function computeTierCaps(tiers: Record<number, RuntimeNode[]>, reqDescriptor: RoutableRequest, attempted: Set<string>, policy: PolicyConfig, knownModels: ReadonlySet<string>): Record<number, number> {
  const now = Date.now();
  const caps: Record<number, number> = {};
  for (const t of TIER_ORDER) caps[t] = 0;
  const dispatchable = TIER_ORDER.filter((t) =>
    t === 1
      ? tier1Dispatchable(tiers[t], reqDescriptor, attempted, now, knownModels)
      : tierHasDispatchableNode(tiers[t], reqDescriptor, attempted, now, knownModels));
  if (dispatchable.length === 0) return caps;

  const max = policy.maxAttempts;
  const explicitTotal = TIER_ORDER.reduce((sum, t) =>
    sum + (policy.tierAttempts?.[`tier${t}`] ?? 0), 0);
  const hasExplicit = TIER_ORDER.some((t) =>
    policy.tierAttempts?.[`tier${t}`] !== undefined);
  const adjustable = dispatchable.filter((t) =>
    policy.tierAttempts?.[`tier${t}`] === undefined);

  for (const t of dispatchable) {
    const override = policy.tierAttempts?.[`tier${t}`];
    if (override !== undefined) caps[t] = override;
  }

  const liveCount = (tierNumber: number): number => {
    return tierNumber === 1
      ? tier1LiveCount(tiers[tierNumber], reqDescriptor, attempted, now, knownModels)
      : countDispatchableNodes(tiers[tierNumber], reqDescriptor, attempted, now, knownModels);
  };

  if (policy.budgetSplit === 'weighted') {
    if (adjustable.length === 0) return caps;
    const remaining = Math.max(0, max - explicitTotal);
    if (remaining === 0) return caps;

    const totalLive = adjustable.reduce((sum, t) => sum + liveCount(t), 0);
    if (totalLive === 0) return caps;

    // Give each adjustable tier a one-attempt baseline when budget permits,
    // then distribute the remaining surplus by live-node weight. If fewer
    // slots remain than adjustable tiers, strict tier order receives them.
    const baselineCount = Math.min(remaining, adjustable.length);
    for (let i = 0; i < baselineCount; i++) caps[adjustable[i]] = 1;
    if (remaining <= baselineCount) return caps;

    const surplus = remaining - baselineCount;
    adjustable.forEach((t, i) => {
      const baseline = i < baselineCount ? 1 : 0;
      const weightShare = Math.floor(surplus * (liveCount(t) / totalLive));
      caps[t] = baseline + weightShare;
    });

    // Floor rounding remainder belongs only to an adjustable tier; explicit
    // tier_attempts are never changed to reconcile totals.
    const usedAdjustable = adjustable.reduce((sum, t) => sum + caps[t], 0);
    const remainder = remaining - usedAdjustable;
    if (remainder > 0) {
      const lastAdjustable = adjustable[adjustable.length - 1];
      caps[lastAdjustable] += remainder;
    }
    return caps;
  }

  // With no explicit caps, preserve the existing default allocation exactly.
  if (!hasExplicit) {
    const surplus = Math.max(0, max - dispatchable.length);
    dispatchable.forEach((t, i) => {
      caps[t] = i === 0 ? 1 + surplus : 1;
    });
    return caps;
  }

  // With explicit caps, only the remaining budget is adjustable. Keep the
  // default Tier precedence by giving any surplus to the first adjustable tier.
  if (adjustable.length === 0) return caps;
  const remaining = Math.max(0, max - explicitTotal);
  if (remaining === 0) return caps;
  const baselineCount = Math.min(remaining, adjustable.length);
  for (let i = 0; i < baselineCount; i++) caps[adjustable[i]] = 1;
  if (remaining > baselineCount) caps[adjustable[0]] += remaining - baselineCount;
  return caps;
}

// Number of upstream dispatches that can still happen in this request after
// applying live availability, per-tier caps, strict tier order, and the shared
// policy cap. This is recomputed before every attempt because a pre-dispatch
// deny or a concurrent request can change the live candidate set.
export function countRemainingDispatchableAttempts(tiers: Record<number, RuntimeNode[]>, reqDescriptor: RoutableRequest, attempted: Set<string>, tierCaps: Record<number, number>, currentTier: Tier, usedInTier: number, sharedRemaining: number, knownModels: ReadonlySet<string>): number {
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
      ? tier1LiveCount(tiers[tierNumber], reqDescriptor, attempted, now, knownModels)
      : countDispatchableNodes(tiers[tierNumber], reqDescriptor, attempted, now, knownModels);
    total += Math.min(capRemaining, live);
  }
  return Math.max(1, Math.min(Math.max(1, sharedRemaining), total || 1));
}
