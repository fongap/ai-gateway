// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Tier 1 selection: Eligibility -> Affinity -> P2C -> Score.
// Static node priority/RPM/concurrency values do not participate. Live
// in-flight pressure, passive TTFT, reliability state, provider-model heat and
// soft session affinity are the only scheduling signals.

import {
  isTier1Eligible,
  claimTier1Slot,
  makeTier1ReleaseToken,
  calculateTier1Score,
  maybeTransitionToHalfOpen,
} from '../reliability/tier1-state.ts';
import { tier1CanAcceptHedge, tier1SelectionHeatFactor } from '../reliability/tier1-heat.ts';
import { tier1AffinityFactor, affinityShouldEscape } from './tier1-affinity.ts';
import type { RuntimeNode } from '../types/node.ts';
import type { RoutableRequest, PickedCandidate } from '../types/scheduler.ts';

const CONSERVATIVE_ATTEMPT_COST_MS = 500;

export function tier1DeadlineTooSmall(remainingBudgetMs: number, p99TtftMs?: number | null): boolean {
  const cost = p99TtftMs && p99TtftMs > 0 ? p99TtftMs * 3 : CONSERVATIVE_ATTEMPT_COST_MS;
  return remainingBudgetMs < cost;
}

export function pickTier1Candidate(
  tier1Nodes: ReadonlyArray<RuntimeNode>,
  req: RoutableRequest,
  attempted: Set<string>,
  {
    affinityAccountId = null,
    evaluateAffinity = false,
    now = Date.now(),
    excludeId = null,
    rng = Math.random,
    knownModels = null,
    raceLostIds = null,
  }: {
    affinityAccountId?: string | null,
    evaluateAffinity?: boolean,
    now?: number,
    excludeId?: string | null,
    rng?: () => number,
    knownModels?: ReadonlySet<string> | null,
    raceLostIds?: Set<string> | null,
  } = {},
): PickedCandidate | null {
  const eligible: RuntimeNode[] = [];
  for (const node of tier1Nodes) {
    if (node.id === excludeId || raceLostIds?.has(node.id) || attempted.has(node.id)) continue;
    maybeTransitionToHalfOpen(node.id, req.model, now);
    if (!isTier1Eligible(node, req, now, knownModels)) continue;
    if (excludeId && !tier1CanAcceptHedge(node)) continue;
    eligible.push(node);
  }
  if (eligible.length === 0) return null;

  const affinityNode = affinityAccountId
    ? eligible.find((node) => node.id === affinityAccountId) ?? null
    : null;

  let chosen: RuntimeNode;
  let escapedFromAffinity = false;
  let updateAffinity = !affinityAccountId;

  const selectionFactor = (node: RuntimeNode): number => tier1SelectionHeatFactor(
    node,
    tier1AffinityFactor(node.id, affinityAccountId),
  );
  const scoreFor = (node: RuntimeNode): number => calculateTier1Score(
    node,
    req.model,
    eligible,
    selectionFactor(node),
    now,
  );

  if (eligible.length === 1) {
    chosen = eligible[0];
  } else {
    const { a, b } = sampleTwo(eligible, rng, affinityNode);
    const scoreA = scoreFor(a);
    const scoreB = scoreFor(b);
    const p2cWinner = scoreA <= scoreB ? a : b;
    const p2cWinnerScore = Math.min(scoreA, scoreB);

    if (affinityNode && affinityNode.id !== p2cWinner.id) {
      const affinityScore = scoreFor(affinityNode);
      if (evaluateAffinity && affinityShouldEscape(affinityScore, p2cWinnerScore)) {
        chosen = p2cWinner;
        escapedFromAffinity = true;
        updateAffinity = true;
      } else if (evaluateAffinity) {
        chosen = affinityNode;
      } else {
        chosen = p2cWinner;
      }
    } else {
      chosen = p2cWinner;
    }
  }

  if (affinityAccountId && !affinityNode) updateAffinity = true;

  if (!claimTier1Slot(chosen, now, req.model)) {
    return { raceLost: true, raceLostNodeId: chosen.id };
  }
  return {
    node: chosen,
    releaseToken: makeTier1ReleaseToken(chosen.id),
    escapedFromAffinity,
    updateAffinity,
    affinityHit: Boolean(affinityAccountId && chosen.id === affinityAccountId),
  };
}

function sampleTwo(
  arr: RuntimeNode[],
  rng: () => number = Math.random,
  affinityNode: RuntimeNode | null = null,
): { a: RuntimeNode, b: RuntimeNode } {
  if (affinityNode) {
    const peers = arr.filter((node) => node.id !== affinityNode.id);
    return { a: affinityNode, b: peers[Math.floor(rng() * peers.length)] };
  }
  const i = Math.floor(rng() * arr.length);
  let j = Math.floor(rng() * (arr.length - 1));
  if (j >= i) j += 1;
  return { a: arr[i], b: arr[j] };
}
