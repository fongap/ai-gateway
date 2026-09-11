// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Tier 1 selection — Eligibility -> Affinity -> P2C -> Score.
//
// No full ordering. From the eligible pool we sample two distinct accounts
// and keep the lower score; a single eligible account is chosen directly.
// UNKNOWN accounts (ttftEwma == null) still get sampled — a small
// exploration factor gives them a chance without distorting known data.
//
// Concurrency is deliberately soft: live in-flight work affects ranking and
// hedge admission, but an operator-guessed limits.concurrency value never makes
// a primary candidate ineligible. Hard RPM remains available when explicitly
// configured.
//
// This module touches Tier 1 ONLY. Tier 2 / Tier 3 keep using
// src/scheduler/scheduler.ts.

import {
  isTier1Eligible, claimTier1Slot, makeTier1ReleaseToken,
  calculateTier1Score, maybeTransitionToHalfOpen,
} from '../reliability/tier1-state.ts';
import {
  tier1CanAcceptHedge,
  tier1SelectionHeatFactor,
} from '../reliability/tier1-heat.ts';
import { tier1AffinityFactor, affinityShouldEscape } from './tier1-affinity.ts';
import type { RuntimeNode } from '../types/node.ts';
import type { RoutableRequest, PickedCandidate } from '../types/scheduler.ts';

// Conservative fixed estimate of one upstream attempt cost when no P99 TTFT is
// available. Used only to decide whether the remaining request deadline can
// fit one more Tier 1 attempt — the shared failover budget stays the real
// wall-clock cap.
const CONSERVATIVE_ATTEMPT_COST_MS = 500;
const SOFT_ONLY_CONCURRENCY = Number.MAX_SAFE_INTEGER;

// tier1-state predates soft-only concurrency and still accepts a RuntimeNode
// whose concurrency field is used as an admission ceiling and load denominator.
// Feed it an attempt-local view with an effectively unbounded concurrency so
// configured limits.concurrency cannot hard-block or double-penalize selection.
// The real node remains unchanged; live in-flight ranking lives in tier1-heat.
function withoutHardConcurrency(node: RuntimeNode): RuntimeNode {
  if (node.limits.concurrency === SOFT_ONLY_CONCURRENCY) return node;
  return {
    ...node,
    limits: { ...node.limits, concurrency: SOFT_ONLY_CONCURRENCY },
  };
}

// Remaining deadline too small to fit one more attempt? Tier 1 then yields to
// the Tier Router immediately instead of burning the budget on a doomed attempt.
export function tier1DeadlineTooSmall(remainingBudgetMs: number, p99TtftMs?: number | null): boolean {
  const cost = p99TtftMs && p99TtftMs > 0 ? p99TtftMs * 3 : CONSERVATIVE_ATTEMPT_COST_MS;
  return remainingBudgetMs < cost;
}

// Pick and claim one Tier 1 candidate, or null when the pool is exhausted.
// Returns { node, releaseToken, escapedFromAffinity } on success, or
// { raceLost: true } when the runtime admission state moved under us, or null
// when no eligible candidate remains.
//
//   affinityAccountId  — the session's preferred account (null = cold session)
//   evaluateAffinity  — whether a successful non-affinity winner may migrate
//     the stored binding (escape window reached).
//   excludeId          — skip the hedge primary when picking a twin. A non-null
//     value also marks hedge selection, where soft spare-capacity gating applies.
export function pickTier1Candidate(tier1Nodes: ReadonlyArray<RuntimeNode>, req: RoutableRequest, attempted: Set<string>, {
  affinityAccountId = null, evaluateAffinity = false, now = Date.now(),
  excludeId = null, rng = Math.random, knownModels = null,
  raceLostIds = null,
}: {
  affinityAccountId?: string | null,
  evaluateAffinity?: boolean,
  now?: number,
  excludeId?: string | null,
  rng?: () => number,
  knownModels?: ReadonlySet<string> | null,
  raceLostIds?: Set<string> | null,
} = {}): PickedCandidate | null {
  const eligible: RuntimeNode[] = [];
  for (const node of tier1Nodes) {
    if (node.id === excludeId) continue;
    if (raceLostIds?.has(node.id)) continue;
    if (attempted.has(node.id)) continue;
    // Lazily move expired cooldowns to HALF_OPEN so a real request can probe
    // recovery — no background probe is ever sent.
    maybeTransitionToHalfOpen(node.id, req.model, now);
    if (!isTier1Eligible(withoutHardConcurrency(node), req, now, knownModels)) continue;
    // Hedge is optional latency work. Keep twins away from already-busy
    // accounts using soft live-load pressure; primary selection is unaffected.
    if (excludeId && !tier1CanAcceptHedge(node, now)) continue;
    eligible.push(node);
  }
  if (eligible.length === 0) return null;

  const affinityNode = affinityAccountId
    ? eligible.find((n) => n.id === affinityAccountId) : null;

  let chosen: RuntimeNode;
  let escapedFromAffinity = false;
  let updateAffinity = !affinityAccountId;

  const selectionFactor = (node: RuntimeNode): number => tier1SelectionHeatFactor(
    node,
    tier1AffinityFactor(node.id, affinityAccountId),
    now,
  );
  const scoreFor = (node: RuntimeNode): number => calculateTier1Score(
    withoutHardConcurrency(node), req.model, eligible,
    selectionFactor(node), now,
  );

  if (eligible.length === 1) {
    chosen = eligible[0];
  } else {
    // P2C remains a real two-account comparison even with affinity. When the
    // preferred account is eligible it occupies one sample slot and competes
    // with one random peer. Live in-flight heat weakens affinity and softly
    // demotes busy accounts without ever removing them from the primary pool.
    const { a, b } = sampleTwo(eligible, rng, affinityNode);
    const scoreA = scoreFor(a);
    const scoreB = scoreFor(b);
    const p2cWinner = scoreA <= scoreB ? a : b;
    const p2cWinnerScore = Math.min(scoreA, scoreB);

    if (affinityNode && affinityNode.id !== p2cWinner.id) {
      // Affinity vs this round's P2C winner only — never a full-pool scan.
      const affScore = scoreFor(affinityNode);
      if (evaluateAffinity && affinityShouldEscape(affScore, p2cWinnerScore)) {
        chosen = p2cWinner;
        escapedFromAffinity = true;
        updateAffinity = true;
      } else if (evaluateAffinity) {
        chosen = affinityNode;
      } else {
        // A peer can serve this individual request when its biased score wins,
        // but the durable binding is not migrated before the escape window.
        chosen = p2cWinner;
      }
    } else {
      chosen = p2cWinner;
    }
  }

  // A stored account that is no longer eligible is replaced only after the
  // selected real request succeeds.
  if (affinityAccountId && !affinityNode) updateAffinity = true;

  if (!claimTier1Slot(withoutHardConcurrency(chosen), now, req.model)) {
    // Lost the race for runtime admission (e.g. RPM/recovery probe moved under
    // us). This is NOT a node failure; the caller re-evaluates the tier.
    return { raceLost: true };
  }
  return {
    node: chosen,
    releaseToken: makeTier1ReleaseToken(chosen.id),
    escapedFromAffinity,
    updateAffinity,
    affinityHit: Boolean(affinityAccountId && chosen.id === affinityAccountId),
  };
}

// Sample two distinct indices uniformly. P2C needs randomness, not sorting.
// `rng` is an injectable uniform [0,1) source for deterministic tests; in
// production Math.random is used so behaviour stays best-effort random and
// no new env knob is required.
function sampleTwo(arr: RuntimeNode[], rng: () => number = Math.random, affinityNode: RuntimeNode | null = null): { a: RuntimeNode, b: RuntimeNode } {
  if (affinityNode) {
    const peers = arr.filter((node) => node.id !== affinityNode.id);
    return { a: affinityNode, b: peers[Math.floor(rng() * peers.length)] };
  }
  const i = Math.floor(rng() * arr.length);
  let j = Math.floor(rng() * (arr.length - 1));
  if (j >= i) j += 1;
  return { a: arr[i], b: arr[j] };
}
