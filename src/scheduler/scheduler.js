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
//   priority ASC -> activeRequests ASC -> health DESC (band) -> lastUsedAt ASC
//   (LRU) -> avg latency ASC
//
// The LRU tiebreak spreads sequential traffic across equal-priority free keys
// instead of hammering one node until it rate-limits — 429 prevention rather
// than 429 reaction.

import { peekAvailability, acquireSlot, getNodeState, rpmUsage } from '../reliability/node-state.js';

export function supportsModel(node, logicalModel) {
  // Empty models map = wildcard (node serves any configured logical model).
  for (const key in node.models) {
    if (Object.hasOwn(node.models, key)) {
      return Object.hasOwn(node.models, logicalModel);
    }
  }
  return true;
}

function underRpmCap(node, now) {
  const rpm = node.limits.rpm;
  if (!rpm) return true;
  return rpmUsage(node.id, now) < rpm;
}

// Pick and claim the best eligible node from one tier, or return null.
// `attempted` is the request-scoped Set of node ids that already failed.
//
// nodes with limits.rpm are SOFT-capped: when every candidate has exhausted
// its per-minute quota the cap is ignored rather than failing the request —
// a single-node setup must never hard-fail just because a minute boundary
// hasn't arrived yet.
export function pickCandidate(tierNodes, requestedModel, attempted, now = Date.now()) {
  let best = null;
  let bestState = null;
  let bestUncapped = null;
  let bestUncappedState = null;

  for (const node of tierNodes) {
    if (attempted.has(node.id)) continue;
    if (!supportsModel(node, requestedModel)) continue;
    if (peekAvailability(node.id, now) === 'no') continue;
    const s = getNodeState(node.id);
    if (s.activeRequests >= node.limits.concurrency) continue;
    if (underRpmCap(node, now)) {
      if (!best || betterThan(s, node, bestState, best)) {
        best = node;
        bestState = s;
      }
    }
    if (!bestUncapped || betterThan(s, node, bestUncappedState, bestUncapped)) {
      bestUncapped = node;
      bestUncappedState = s;
    }
  }

  const chosen = best || bestUncapped;
  if (!chosen) return null;
  // Claim the slot (and the half-open probe, if this node was probe-ready).
  // Re-check inside acquireSlot keeps the claim atomic.
  if (!acquireSlot(chosen.id, now)) return null;
  return chosen;
}

// True when this tier could serve the model if it had capacity right now
// (every candidate busy at its concurrency limit or soft-RPM capped).
// Used to distinguish "saturated" from "cooling down" in client responses.
export function tierHasDeferredCapacity(tierNodes, requestedModel, attempted, now = Date.now()) {
  for (const node of tierNodes) {
    if (attempted.has(node.id)) continue;
    if (!supportsModel(node, requestedModel)) continue;
    if (peekAvailability(node.id, now) === 'no') continue;
    const s = getNodeState(node.id);
    if (s.activeRequests >= node.limits.concurrency) return true;
    if (!underRpmCap(node, now)) return true;
  }
  return false;
}

// Health differences below this band are noise (one success = +3); treat them
// as a tie so LRU can rotate traffic across healthy equal-priority nodes.
const HEALTH_TIE_BAND = 10;

function betterThan(a, aNode, b, bNode) {
  if (aNode.priority !== bNode.priority) return aNode.priority < bNode.priority;
  if (a.activeRequests !== b.activeRequests) return a.activeRequests < b.activeRequests;
  if (Math.abs(a.healthScore - b.healthScore) >= HEALTH_TIE_BAND) {
    return a.healthScore > b.healthScore;
  }
  // LRU: prefer the node idle longest (0 = never used). This rotates
  // sequential traffic across free keys instead of concentrating it on one
  // node until it rate-limits.
  if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt < b.lastUsedAt;
  return a.avgLatencyMs < b.avgLatencyMs;
}
