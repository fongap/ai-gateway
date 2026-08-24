// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Dynamic candidate selection.
//
// There is NO static retry index. Before every attempt the eligible set is
// recomputed from current node state:
//   valid config -> model supported -> circuit available -> cooldown expired
//   -> concurrency available -> not already attempted in this request
// then the best candidate is picked with a single O(n) pass:
//   priority ASC -> activeRequests ASC -> health DESC -> avg latency ASC

import { peekAvailability, acquireSlot, getNodeState } from '../reliability/node-state.js';

export function supportsModel(node, logicalModel) {
  // Empty models map = wildcard (node serves any configured logical model).
  for (const key in node.models) {
    if (Object.hasOwn(node.models, key)) {
      return Object.hasOwn(node.models, logicalModel);
    }
  }
  return true;
}

// Pick and claim the best eligible node from one tier, or return null.
// `attempted` is the request-scoped Set of node ids that already failed.
export function pickCandidate(tierNodes, requestedModel, attempted, now = Date.now()) {
  let best = null;
  let bestState = null;

  for (const node of tierNodes) {
    if (attempted.has(node.id)) continue;
    if (!supportsModel(node, requestedModel)) continue;
    if (peekAvailability(node.id, now) === 'no') continue;
    const s = getNodeState(node.id);
    if (s.activeRequests >= node.limits.concurrency) continue;
    if (!best || betterThan(s, node, bestState, best)) {
      best = node;
      bestState = s;
    }
  }

  if (!best) return null;
  // Claim the slot (and the half-open probe, if this node was probe-ready).
  // Re-check inside acquireSlot keeps the claim atomic.
  if (!acquireSlot(best.id, now)) return null;
  return best;
}

function betterThan(a, aNode, b, bNode) {
  if (aNode.priority !== bNode.priority) return aNode.priority < bNode.priority;
  if (a.activeRequests !== b.activeRequests) return a.activeRequests < b.activeRequests;
  if (a.healthScore !== b.healthScore) return a.healthScore > b.healthScore;
  return a.avgLatencyMs < b.avgLatencyMs;
}

// Group nodes by tier number: { 1: [...], 2: [...], 3: [...] }.
export function groupNodesByTier(nodes) {
  const tiers = { 1: [], 2: [], 3: [] };
  for (const node of nodes) {
    const num = Number(node.tier.slice(5));
    if (tiers[num]) tiers[num].push(node);
  }
  for (const list of Object.values(tiers)) {
    list.sort((a, b) => a.priority - b.priority);
  }
  return tiers;
}
