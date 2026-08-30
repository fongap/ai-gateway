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
//   priority ASC -> activeRequests ASC -> health DESC (band) -> rolling-latency
//   preference (decisive EWMA advantage) -> lastUsedAt ASC (LRU) -> avg latency
//   ASC
//
// The LRU tiebreak spreads sequential traffic across equal-priority free keys
// instead of hammering one node until it rate-limits — 429 prevention rather
// than 429 reaction. The latency preference above it adapts to speed drift:
// upstreams get faster and slower over time, so measured recent latency — not
// a static snapshot — decides between otherwise-equal candidates.

import { peekAvailability, acquireSlot, getNodeState, rpmUsage, isModelCooling } from '../reliability/node-state.js';
import { servesModel } from '../config/registry.js';

export function supportsModel(node, logicalModel) {
  // Empty models map = wildcard (node serves any configured logical model).
  return servesModel(node, logicalModel);
}

function underRpmCap(node, now) {
  const rpm = node.limits.rpm;
  if (!rpm) return true;
  return rpmUsage(node.id, now) < rpm;
}

// A HARD rpm cap is a real upstream/account quota: once the isolate-local
// counter reaches it the node must not be dispatched again this minute.
// SOFT caps (explicit "rpm_mode": "soft") keep the old best-effort behavior.
export function isHardRpmExhausted(node, now = Date.now()) {
  const rpm = node.limits.rpm;
  if (!rpm || node.limits.rpmMode === 'soft') return false;
  return rpmUsage(node.id, now) >= rpm;
}

// Seconds until the current RPM minute window resets (for Retry-After).
export function rpmWindowRetryAfterSec(now = Date.now()) {
  return Math.max(1, Math.ceil((60_000 - (now % 60_000)) / 1000));
}

// Pick and claim the best eligible node from one tier, or return null.
// `attempted` is the request-scoped Set of node ids that already failed.
//
// RPM semantics:
//   hard (default when limits.rpm is set): an exhausted node is NOT a fallback
//     candidate — the gateway would knowingly exceed the configured quota
//     otherwise. When every candidate is exhausted the tier is skipped.
//   soft ("rpm_mode":"soft"): exhausted nodes remain last-resort candidates so
//     a lone capped node still serves instead of failing the request.
export function pickCandidate(tierNodes, requestedModel, attempted, now = Date.now(), excludeId = null) {
  let best = null;
  let bestState = null;
  let bestUncapped = null;
  let bestUncappedState = null;

  for (const node of tierNodes) {
    if (node.id === excludeId) continue;
    if (attempted.has(node.id)) continue;
    if (!supportsModel(node, requestedModel)) continue;
    if (peekAvailability(node.id, now) === 'no') continue;
    // A (node, model) pair in model_missing cooldown is skipped without
    // disabling the node for its other models.
    if (isModelCooling(node.id, requestedModel, now)) continue;
    const s = getNodeState(node.id);
    if (s.activeRequests >= node.limits.concurrency) continue;
    if (underRpmCap(node, now)) {
      if (!best || betterThan(s, node, bestState, best)) {
        best = node;
        bestState = s;
      }
    }
    // Only SOFT-capped (or uncapped) nodes may serve past their counter.
    if (!isHardRpmExhausted(node, now)) {
      if (!bestUncapped || betterThan(s, node, bestUncappedState, bestUncapped)) {
        bestUncapped = node;
        bestUncappedState = s;
      }
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
// (every candidate busy at its concurrency limit or hard-RPM exhausted). Used
// to distinguish "saturated" from "cooling down" in client responses.
export function tierHasDeferredCapacity(tierNodes, requestedModel, attempted, now = Date.now()) {
  for (const node of tierNodes) {
    if (attempted.has(node.id)) continue;
    if (!supportsModel(node, requestedModel)) continue;
    if (peekAvailability(node.id, now) === 'no') continue;
    if (isModelCooling(node.id, requestedModel, now)) continue;
    const s = getNodeState(node.id);
    if (s.activeRequests >= node.limits.concurrency) return true;
    if (isHardRpmExhausted(node, now)) return true;
  }
  return false;
}

// DISPATCHABLE capacity: a candidate this tier could truly launch THIS INSTANT.
// Dispatchability-aware mirror of pickCandidate's gates, used to decide whether
// a LOWER tier deserves an attempt budget: budget is handed out only when the
// tier can spend it right now, never for merely-*configured* support that would
// sit unused while the preferred tier still has usable candidates. Soft-RPM-
// exhausted nodes DO count as dispatchable — pickCandidate keeps them
// selectable as last resort, so budget must agree with selection. Deferred
// capacity (concurrency-saturated / hard-RPM-exhausted) belongs to
// tierHasDeferredCapacity instead: Retry-After and diagnostics, no budget.
export function tierHasDispatchableNode(tierNodes, requestedModel, attempted, now = Date.now()) {
  return countDispatchableNodes(tierNodes, requestedModel, attempted, now) > 0;
}

// Count candidates that pickCandidate could dispatch right now without
// claiming their slots.  The request pipeline uses this to divide its
// remaining wall-clock budget across attempts that can actually happen,
// rather than across a policy maximum that may be larger than the live pool.
export function countDispatchableNodes(tierNodes, requestedModel, attempted, now = Date.now()) {
  let count = 0;
  for (const node of tierNodes) {
    if (attempted.has(node.id)) continue;
    if (!supportsModel(node, requestedModel)) continue;
    if (peekAvailability(node.id, now) === 'no') continue;
    if (isModelCooling(node.id, requestedModel, now)) continue;
    if (getNodeState(node.id).activeRequests >= node.limits.concurrency) continue;
    if (isHardRpmExhausted(node, now)) continue;
    count++;
  }
  return count;
}

// Health differences below this band are noise (one success = +3); treat them
// as a tie so LRU can rotate traffic across healthy equal-priority nodes.
const HEALTH_TIE_BAND = 10;
// Upstream speed drifts over time, so static priority alone is a stale
// snapshot. When both candidates have measured latency and one is decisively
// faster right now, it wins before LRU gets a vote — a node that slows down
// sheds traffic automatically and rejoins the rotation when it recovers.
const LATENCY_ADVANTAGE_FACTOR = 1.5;

function betterThan(a, aNode, b, bNode) {
  if (aNode.priority !== bNode.priority) return aNode.priority < bNode.priority;
  if (a.activeRequests !== b.activeRequests) return a.activeRequests < b.activeRequests;
  if (Math.abs(a.healthScore - b.healthScore) >= HEALTH_TIE_BAND) {
    return a.healthScore > b.healthScore;
  }
  // Rolling-latency preference (EWMA, α=0.3). Unknown latency (0) is neutral:
  // fresh nodes still receive traffic and learn their speed.
  if (a.avgLatencyMs > 0 && b.avgLatencyMs > 0) {
    if (a.avgLatencyMs <= b.avgLatencyMs / LATENCY_ADVANTAGE_FACTOR) return true;
    if (b.avgLatencyMs <= a.avgLatencyMs / LATENCY_ADVANTAGE_FACTOR) return false;
  }
  // LRU: prefer the node idle longest (0 = never used). This rotates
  // sequential traffic across free keys instead of concentrating it on one
  // node until it rate-limits.
  if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt < b.lastUsedAt;
  return a.avgLatencyMs < b.avgLatencyMs;
}
