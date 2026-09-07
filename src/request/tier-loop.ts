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
// dispatchable-count. The actual dispatchAttempt / attemptNode / handleSuccess
// closures stay in handler.ts; they capture the per-request logger and
// reliability API. Relocation of the attempt body into attempt.ts is
// planned as a separate behavior-preserving refactor.

import { TIER_ORDER } from './router.ts';
import { pickCandidate, tierHasDispatchableNode, countDispatchableNodes } from '../scheduler/scheduler.ts';
import { pickTier1Candidate } from '../scheduler/tier1-scheduler.ts';
import { tier1HasDispatchableNode, tier1CountDispatchableNodes, TIER1_MAX_ATTEMPTS } from '../reliability/tier1-state.ts';
import type { Tier, RoutableRequest } from '../types/scheduler.ts';
import type { RuntimeNode } from '../types/node.ts';
import type { PolicyConfig } from '../types/policy.ts';

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
};

// Tier-aware picker. Tier 1 uses P2C + affinity + tier1-state eligibility;
// Tier 2/3 use the existing node-state pickCandidate unchanged. Returns
// { node, tier1ReleaseToken?, tier1EscapedFromAffinity? } or { raceLost } or null.
// An optional deterministic RNG (from TIER1_SCHEDULER_SEED) makes P2C sampling
// reproducible in tests without adding a production env knob — when the seed
// is absent (production), Math.random is used and behaviour stays random.
export function pickForTier(tierNumber: Tier, tierNodes: ReadonlyArray<RuntimeNode>, req: RoutableRequest, attempted: Set<string>, opts: PickForTierOpts = {}): TierPickResult {
  const { knownModels } = opts;
  if (tierNumber !== 1) {
    // R4 (v1.3.0): pickCandidate now returns PickedCandidate | null,
    // matching pickTier1Candidate. The Tier 2/3 path no longer wraps a
    // bare RuntimeNode — it receives { node } | { raceLost: true } | null
    // directly, so race-loss is visible to the caller (previously it was
    // indistinguishable from "no eligible candidate" and the tier loop
    // would skip to the next tier instead of retrying).
    const r = pickCandidate(tierNodes, req, attempted, undefined, null, knownModels);
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
//   * Two capacity notions are kept strictly apart. DISPATCHABLE means a
//     candidate this tier could truly launch right now (supports the model,
//     circuit/model cooldown clear, under concurrency, not hard-RPM exhausted);
//     DEFERRED means capacity exists but cannot serve yet (saturated /
//     over-quota). Deferred capacity feeds only Retry-After and diagnostic
//     classification (see tierHasDeferredCapacity in scheduler.ts) — it earns
//     NO budget, otherwise an attempt slot gets reserved for a tier that will
//     refuse dispatch while the current tier may still have immediately usable
//     candidates left to spend that slot on.
//   * A tier with no dispatchable candidate for the request descriptor gets 0
//     budget.
//   * The surplus = max_attempts - dispatchable_tier_count is distributed
//     across dispatchable tiers according to `policy.budgetSplit`:
//       - "even" (default, backward-compatible): the first (most-preferred)
//         dispatchable tier receives the ENTIRE surplus, maximizing free /
//         priority resource use. Existing tests and behavior are unchanged.
//       - "weighted" (R5, opt-in): the surplus is distributed proportionally
//         to each tier's live dispatchable node count, so a lower tier with
//         significantly more capacity gets more attempts than a higher tier
//         with fewer candidates.
//     `tier_attempts` (when explicitly set) always wins for the tier it
//     names; `budget_split` is only consulted for tiers without an override.
//   * `policy.tierAttempts` (POLICIES_CONFIG tier_attempts) overrides a tier's
//     budget explicitly (0 disables it).
// Budget is a per-tier UPPER bound; the shared state.maxAttempts still caps the
// request's total upstream attempts, and FAILOVER_BUDGET_MS caps wall-clock.
export function computeTierCaps(tiers: Record<number, RuntimeNode[]>, reqDescriptor: RoutableRequest, attempted: Set<string>, policy: PolicyConfig, knownModels: ReadonlySet<string>): Record<number, number> {
  const now = Date.now();
  const caps: Record<number, number> = {};
  for (const t of TIER_ORDER) caps[t] = 0;
  const dispatchable = TIER_ORDER.filter((t) =>
    t === 1
      ? tier1HasDispatchableNode(tiers[t], reqDescriptor, attempted, now, knownModels)
      : tierHasDispatchableNode(tiers[t], reqDescriptor, attempted, now, knownModels));
  if (dispatchable.length === 0) return caps;
  const max = policy.maxAttempts;
  // R5: when budget_split === 'weighted', count live dispatchable nodes per
  // tier and distribute the surplus proportionally. A lower tier with
  // significantly more capacity gets a larger share.
  const liveCount = (tierNumber: number): number => {
    return tierNumber === 1
      ? tier1CountDispatchableNodes(tiers[tierNumber], reqDescriptor, attempted, now, knownModels)
      : countDispatchableNodes(tiers[tierNumber], reqDescriptor, attempted, now, knownModels);
  };
  const useWeighted = policy.budgetSplit === 'weighted';
  if (useWeighted) {
    // Per-tier surplus by node-count weight. Each tier first gets 1 attempt
    // (its baseline share), and any extra surplus is distributed by weight.
    // `tier_attempts` overrides win as before. After per-tier computation,
    // the last dispatchable tier absorbs the rounding remainder so the
    // totals are stable AND within max.
    const totalLive = dispatchable.reduce((s, t) => s + liveCount(t), 0);
    if (totalLive === 0) return caps;
    const surplus = Math.max(0, max - dispatchable.length);
    const tierShare = (tierNumber: number): number => {
      const w = liveCount(tierNumber) / totalLive;
      return 1 + Math.floor(surplus * w);
    };
    dispatchable.forEach((t, i) => {
      const override = policy.tierAttempts?.[`tier${t}`];
      if (override !== undefined) caps[t] = override;
      else caps[t] = tierShare(t);
      if (t === 1) caps[t] = Math.min(caps[t], TIER1_MAX_ATTEMPTS);
    });
    // Reconcile to exactly max_attempts. Any over- or under-allocation from
    // floor rounding or override choices is absorbed by the last tier.
    const last = dispatchable[dispatchable.length - 1];
    const usedSoFar = dispatchable.reduce((s, t) => s + caps[t], 0);
    if (usedSoFar > max) {
      // Over-budget: trim the last tier. (Over-budget happens when an
      // override sum exceeds max; this is the operator's call to make but
      // we MUST respect max.)
      caps[last] = Math.max(1, caps[last] - (usedSoFar - max));
    } else {
      const remaining = max - usedSoFar;
      if (remaining > 0) caps[last] = caps[last] + remaining;
    }
    return caps;
  }
  // Default: "even" (backward-compatible) — first dispatchable tier gets the
  // entire surplus.
  const surplus = Math.max(0, max - dispatchable.length);
  dispatchable.forEach((t, i) => {
    // `t` is numeric (1/2/3); POLICIES_CONFIG tier_attempts uses string keys
    // ('tier1'/'tier2'/'tier3').
    caps[t] = policy.tierAttempts?.[`tier${t}`] ?? (i === 0 ? 1 + surplus : 1);
    if (t === 1) caps[t] = Math.min(caps[t], TIER1_MAX_ATTEMPTS);
  });
  return caps;
}

// Number of upstream dispatches that can still happen in this request after
// applying live availability, per-tier caps, strict tier order, and the shared
// policy cap.  This is deliberately recomputed before every attempt because a
// pre-dispatch deny or a concurrent request can change the live candidate set.
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
      ? tier1CountDispatchableNodes(tiers[tierNumber], reqDescriptor, attempted, now, knownModels)
      : countDispatchableNodes(tiers[tierNumber], reqDescriptor, attempted, now, knownModels);
    total += Math.min(capRemaining, live);
  }
  return Math.max(1, Math.min(Math.max(1, sharedRemaining), total || 1));
}
