// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Dynamic candidate selection.
//
// There is NO static retry index. Before every attempt the eligible set is
// recomputed from current node state:
//   valid config -> protocol matches -> surface supported -> model supported
//   -> circuit available -> cooldown expired
//   -> concurrency available -> not already attempted in this request
// then the best candidate is picked with a single O(n) pass:
//   priority ASC -> activeRequests ASC -> health DESC (band) -> first-token
//   latency preference (TTFT EWMA when measured, header-latency EWMA as
//   fallback; decisive advantage only) -> lastUsedAt ASC (LRU) -> avg latency
//   ASC
//
// The LRU tiebreak spreads sequential traffic across equal-priority free keys
// instead of hammering one node until it rate-limits — 429 prevention rather
// than 429 reaction. The latency preference above it adapts to speed drift:
// upstreams get faster and slower over time, so measured recent latency — not
// a static snapshot — decides between otherwise-equal candidates.
//
// Protocol/surface isolation is a HARD scheduler gate, not a preference: an
// OpenAI request is never routed to an Anthropic node and vice versa, and a
// node that only serves chat_completions never receives a /v1/responses
// request. There is no cross-protocol conversion and no cross-protocol
// failover anywhere in the gateway.

import { peekAvailability, acquireSlot, getNodeState, rpmUsage, isModelCooling, getModelPerf } from '../reliability/node-state.js';
import { servesModel } from '../config/registry.js';

// A request descriptor: { model, protocol, surface }. Every selection helper
// below filters candidates through ALL THREE dimensions — a node is eligible
// only when its protocol matches, its declared surfaces include the request
// surface, and it serves the logical model.
export function supportsRequest(node, req) {
  if (!req || typeof req !== 'object') return false;
  if (node.protocol !== req.protocol) return false;
  if (!Array.isArray(node.surfaces) || !node.surfaces.includes(req.surface)) return false;
  // Empty models map = wildcard (node serves any configured logical model).
  return servesModel(node, req.model);
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
// `req` is the request descriptor { model, protocol, surface }; `attempted`
// is the request-scoped Set of node ids that already failed. Because the
// eligibility filter includes protocol + surface, a hedge twin picked through
// this function is ALWAYS same-protocol and same-surface as its primary.
//
// RPM semantics:
//   hard (default when limits.rpm is set): an exhausted node is NOT a fallback
//     candidate — the gateway would knowingly exceed the configured quota
//     otherwise. When every candidate is exhausted the tier is skipped.
//   soft ("rpm_mode":"soft"): exhausted nodes remain last-resort candidates so
//     a lone capped node still serves instead of failing the request.
export function pickCandidate(tierNodes, req, attempted, now = Date.now(), excludeId = null) {
  let best = null;
  let bestState = null;
  let bestUncapped = null;
  let bestUncappedState = null;

  for (const node of tierNodes) {
    if (node.id === excludeId) continue;
    if (attempted.has(node.id)) continue;
    if (!supportsRequest(node, req)) continue;
    if (peekAvailability(node.id, now) === 'no') continue;
    // A (node, model) pair in model_missing cooldown is skipped without
    // disabling the node for its other models.
    if (isModelCooling(node.id, req.model, now)) continue;
    const s = getNodeState(node.id);
    if (s.activeRequests >= node.limits.concurrency) continue;
      if (underRpmCap(node, now)) {
        if (!best || betterThan(s, node, bestState, best, req.model, now)) {
          best = node;
          bestState = s;
        }
      }
    // Only SOFT-capped (or uncapped) nodes may serve past their counter.
    if (!isHardRpmExhausted(node, now)) {
      if (!bestUncapped || betterThan(s, node, bestUncappedState, bestUncapped, req.model, now)) {
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

// True when this tier could serve the request if it had capacity right now
// (every candidate busy at its concurrency limit or hard-RPM exhausted). Used
// to distinguish "saturated" from "cooling down" in client responses.
export function tierHasDeferredCapacity(tierNodes, req, attempted, now = Date.now()) {
  for (const node of tierNodes) {
    if (attempted.has(node.id)) continue;
    if (!supportsRequest(node, req)) continue;
    if (peekAvailability(node.id, now) === 'no') continue;
    if (isModelCooling(node.id, req.model, now)) continue;
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
export function tierHasDispatchableNode(tierNodes, req, attempted, now = Date.now()) {
  return countDispatchableNodes(tierNodes, req, attempted, now) > 0;
}

// Count candidates that pickCandidate could dispatch right now without
// claiming their slots.  The request pipeline uses this to divide its
// remaining wall-clock budget across attempts that can actually happen,
// rather than across a policy maximum that may be larger than the live pool.
export function countDispatchableNodes(tierNodes, req, attempted, now = Date.now()) {
  let count = 0;
  for (const node of tierNodes) {
    if (attempted.has(node.id)) continue;
    if (!supportsRequest(node, req)) continue;
    if (peekAvailability(node.id, now) === 'no') continue;
    if (isModelCooling(node.id, req.model, now)) continue;
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
const TRANSIENT_FAILURE_PREFERENCE_MS = 5_000;
const STALE_TTFT_MS = 5 * 60_000;
const QUALITY_TTFT_MS = 15 * 60_000;
const MIN_QUALITY_SAMPLES = 3;

// Resolve the effective TTFT for scheduling, applying freshness and
// confidence gates. Returns 0 (neutral / unmeasured) when:
//   - the per-model metric is stale (last measured > TTL ago; TTL is longer
//     for quality nodes with passiveSamples >= MIN_QUALITY_SAMPLES);
//   - a probe failure occurred after the last TTFT measurement (uncertain);
//   - only probe data exists with no passive validation (probe-only = weak
//     hint, not a decisive latency score — a tiny probe prompt is not a real
//     workload, so its TTFT must not dominate a node with real-request data).
// When no per-model entry exists, the node-level avgTtftMs is the fallback
// (it lacks freshness metadata but is the only signal for a model that has
// not been individually measured yet).
function effectiveTtft(perf, nodeLevelTtft, now) {
  if (!perf) return nodeLevelTtft;
  if (perf.lastTtftAt > 0) {
    const ttl = perf.passiveSamples >= MIN_QUALITY_SAMPLES ? QUALITY_TTFT_MS : STALE_TTFT_MS;
    if (now - perf.lastTtftAt > ttl) return 0;
  }
  if (perf.lastProbeFailureAt > perf.lastTtftAt) return 0;
  if (perf.passiveSamples === 0 && perf.probeSamples > 0) return 0;
  return perf.avgTtftMs;
}

// Streaming is the dominant LLM workload, and what the client feels is when
// tokens START, not when response headers arrive: a node can answer headers in
// 100ms and then stall seconds before the first token. When both candidates
// have measured a first event, TTFT decides. Header-latency EWMA stays as the
// fallback for candidates that have not (e.g. non-stream traffic only); 0
// remains neutral, so fresh nodes still receive traffic and learn their speed.
function latencyPreference(a, aNode, b, bNode, model, now) {
  const aPerf = model ? getModelPerf(aNode.id, model) : null;
  const bPerf = model ? getModelPerf(bNode.id, model) : null;
  const aTtft = effectiveTtft(aPerf, a.avgTtftMs, now);
  const bTtft = effectiveTtft(bPerf, b.avgTtftMs, now);
  if (aTtft > 0 && bTtft > 0) {
    if (aTtft <= bTtft / LATENCY_ADVANTAGE_FACTOR) return true;
    if (bTtft <= aTtft / LATENCY_ADVANTAGE_FACTOR) return false;
    return null;
  }
  const aLat = aPerf?.avgLatencyMs || a.avgLatencyMs;
  const bLat = bPerf?.avgLatencyMs || b.avgLatencyMs;
  if (aLat > 0 && bLat > 0) {
    if (aLat <= bLat / LATENCY_ADVANTAGE_FACTOR) return true;
    if (bLat <= aLat / LATENCY_ADVANTAGE_FACTOR) return false;
  }
  return null;
}

function betterThan(a, aNode, b, bNode, model, now) {
  // One real timeout / network / 5xx is enough to move traffic to a healthy
  // peer immediately. Unlike a cooldown this is only a ranking preference:
  // a sole node remains eligible for recovery and for circuit probing.
  const aRecentlyFailed = a.lastTransientFailureAt > 0
    && now - a.lastTransientFailureAt < TRANSIENT_FAILURE_PREFERENCE_MS;
  const bRecentlyFailed = b.lastTransientFailureAt > 0
    && now - b.lastTransientFailureAt < TRANSIENT_FAILURE_PREFERENCE_MS;
  if (aRecentlyFailed !== bRecentlyFailed) return !aRecentlyFailed;
  if (aNode.priority !== bNode.priority) return aNode.priority < bNode.priority;
  if (a.activeRequests !== b.activeRequests) return a.activeRequests < b.activeRequests;
  if (Math.abs(a.healthScore - b.healthScore) >= HEALTH_TIE_BAND) {
    return a.healthScore > b.healthScore;
  }
  const preference = latencyPreference(a, aNode, b, bNode, model, now);
  if (preference !== null) return preference;
  if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt < b.lastUsedAt;
  return a.avgLatencyMs < b.avgLatencyMs;
}
