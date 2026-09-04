// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Tier 1 selection — Eligibility -> Affinity -> P2C -> Score.
//
// No full ordering. From the eligible pool we sample two distinct accounts
// and keep the lower score; a single eligible account is chosen directly.
// UNKNOWN accounts (ttftEwma == null) still get sampled — a small
// exploration factor gives them a chance without distorting known data.
//
// This module touches Tier 1 ONLY. Tier 2 / Tier 3 keep using
// src/scheduler/scheduler.js (pickCandidate) unchanged.

import {
  isTier1Eligible, claimTier1Slot, makeTier1ReleaseToken,
  calculateTier1Score, maybeTransitionToHalfOpen,
} from '../reliability/tier1-state.js';
import { tier1AffinityFactor, affinityShouldEscape } from './tier1-affinity.js';

// Conservative fixed estimate of one upstream attempt cost when no P99 TTFT is
// available. Used only to decide whether the remaining request deadline can
// fit one more Tier 1 attempt — the shared failover budget stays the real
// wall-clock cap.
const CONSERVATIVE_ATTEMPT_COST_MS = 500;

// Remaining deadline too small to fit one more attempt? Tier 1 then yields to
// the Tier Router immediately instead of burning the budget on a doomed attempt.
export function tier1DeadlineTooSmall(remainingBudgetMs, p99TtftMs) {
  const cost = p99TtftMs && p99TtftMs > 0 ? p99TtftMs * 3 : CONSERVATIVE_ATTEMPT_COST_MS;
  return remainingBudgetMs < cost;
}

// Pick and claim one Tier 1 candidate, or null when the pool is exhausted.
// Returns { node, releaseToken, escapedFromAffinity } on success, or
// { raceLost: true } when the slot was claimed under us (retry-eligible), or
// null when no eligible candidate remains.
//
//   affinityAccountId  — the session's preferred account (null = cold session)
//   evaluateAffinity  — whether a successful non-affinity winner may migrate
//     the stored binding (escape window reached).
//   excludeId          — skip the hedge primary when picking a twin.
export function pickTier1Candidate(tier1Nodes, req, attempted, {
  affinityAccountId = null, evaluateAffinity = false, now = Date.now(),
  excludeId = null, rng = Math.random, knownModels = null,
} = {}) {
  const eligible = [];
  for (const node of tier1Nodes) {
    if (node.id === excludeId) continue;
    if (attempted.has(node.id)) continue;
    // Lazily move expired cooldowns to HALF_OPEN so a real request can probe
    // recovery — no background probe is ever sent.
    maybeTransitionToHalfOpen(node.id, req.model, now);
    if (!isTier1Eligible(node, req, now, knownModels)) continue;
    eligible.push(node);
  }
  if (eligible.length === 0) return null;

  const affinityNode = affinityAccountId
    ? eligible.find((n) => n.id === affinityAccountId) : null;

  let chosen;
  let escapedFromAffinity = false;
  let updateAffinity = !affinityAccountId;

  if (eligible.length === 1) {
    chosen = eligible[0];
  } else {
    // P2C remains a real two-account comparison even with affinity. When the
    // preferred account is eligible it occupies one sample slot and competes
    // with one random peer; the multiplicative bias is therefore soft, not a
    // hidden hard binding.
    const { a, b } = sampleTwo(eligible, rng, affinityNode);
    const scoreA = calculateTier1Score(a, req.model, eligible,
      tier1AffinityFactor(a.id, affinityAccountId), now);
    const scoreB = calculateTier1Score(b, req.model, eligible,
      tier1AffinityFactor(b.id, affinityAccountId), now);
    const p2cWinner = scoreA <= scoreB ? a : b;
    const p2cWinnerScore = Math.min(scoreA, scoreB);

    if (affinityNode && affinityNode.id !== p2cWinner.id) {
      // Affinity vs this round's P2C winner only — never a full-pool scan.
      const affScore = calculateTier1Score(affinityNode, req.model, eligible,
        tier1AffinityFactor(affinityNode.id, affinityAccountId), now);
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

  if (!claimTier1Slot(chosen, now, req.model)) {
    // Lost the race for the slot (concurrency/RPM moved under us): report
    // exhausted for this attempt so the caller re-evaluates. This is NOT a
    // failure — the account stays eligible for a later attempt.
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
function sampleTwo(arr, rng = Math.random, affinityNode = null) {
  if (affinityNode) {
    const peers = arr.filter((node) => node.id !== affinityNode.id);
    return { a: affinityNode, b: peers[Math.floor(rng() * peers.length)] };
  }
  const i = Math.floor(rng() * arr.length);
  let j = Math.floor(rng() * (arr.length - 1));
  if (j >= i) j += 1;
  return { a: arr[i], b: arr[j] };
}
