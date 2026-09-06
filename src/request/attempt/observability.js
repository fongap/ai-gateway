// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
// Part of src/request/attempt.js (behavior-preserving split); see
// attempt/index.js for the module map.

// observability.js - post-outcome recording for one attempt: token
// accounting (isolate-local + fail-open D1 persistence off the hot path),
// node success recording, stream-end telemetry wiring, and Tier 1 non-stream
// TTFT capture. These helpers NEVER change the HTTP response, the failover
// decision, or any budget accounting - they call the public Reliability API
// to record outcomes that the dispatch/success paths already decided.

import {
  recordSuccess, recordNeutralEnd, applyHealthPenalty,
  bumpNodeCounters, recordFailure,
} from '../../reliability/node-state.ts';
import {
  releaseTier1Slot,
  recordTier1Ttft, recordTier1Success, applyTier1Outcome, classifyTier1Failure,
} from '../../reliability/tier1-state.ts';
import { writeTier1Affinity } from '../../scheduler/tier1-affinity.ts';
import { recordStreamStart, recordStreamCompleted, recordStreamInterrupted } from '../../observability/gateway-stats.mjs';
import { recordTokenUsage } from '../../observability/token-usage.mjs';
import { persistTokenUsage } from '../../observability/token-usage-store.mjs';
import { upstreamModelOf } from '../response-helpers.js';

/**
 * @param {AttemptContext} c
 * @param {RuntimeNode} node
 * @param {unknown} data
 * @param {(data: any) => boolean} isMeaningful
 */
export function recordTier1NonStreamTtft(c, node, data, isMeaningful) {
  if (node.tier !== 'tier-1' || !isMeaningful(data)) return;
  c.ttftMs = Date.now() - (c.attemptStartMs ?? Date.now());
  recordTier1Ttft(node.id, c.state.requestedModel, c.ttftMs);
}

// Token observability: called EXACTLY ONCE per delivered response — from the
// non-stream parse points, or via the onUsage callback of the one stream
// wrapper / transform that actually parsed the body. Rotating attempts never
// reach here, so failover still yields a single record.
//
// It does TWO independent things:
//   1. recordTokenUsage()     — isolate-local, best-effort (resets on restart).
//   2. persistTokenUsage()    — cross-isolate D1 hour-bucket UPSERT, fired
//      inside ctx.waitUntil() so it is OFF the request hot path. It is fully
//      fail-open: D1 absence, errors, timeouts and rejects are swallowed here
//      and never change the HTTP response, fallback, node health, circuit
//      breaker, scheduler, concurrency count or stream completion.
/**
 * @param {AttemptContext} c
 * @param {RuntimeNode} node
 * @param {{ prompt_tokens?: number, completion_tokens?: number, total_tokens?: number, input_tokens?: number, output_tokens?: number } | null | undefined} usage
 */
export function recordTokens(c, node, usage) {
  recordTokenUsage({ model: c.requestedModel, tier: node.tier, provider: node.provider, nodeId: node.id, usage });
  scheduleD1TokenPersist(c, usage);
}

// Fire the D1 persistence WITHOUT touching the request path. Wrapped so that:
//   * no binding  -> no-op (the primary "delete TOKEN_STATS_DB and it still
//     serves every model" invariant);
//   * ctx.waitUntil is the ONLY mechanism used — never `await` before a
//     response, never a synchronous D1 call;
//   * every rejection is caught and logged at most once.
//
// TTFT is passed only for successful requests with meaningful output.
// Failures MUST NOT pass a TTFT value — they enter failure statistics only.
/**
 * @param {AttemptContext} c
 * @param {{ prompt_tokens?: number, completion_tokens?: number, total_tokens?: number, input_tokens?: number, output_tokens?: number } | null | undefined} usage
 */
function scheduleD1TokenPersist(c, usage) {
  const task = persistTokenUsage(c.env, usage, Date.now(), c.requestedModel, c.ttftMs ?? null).catch((err) => {
    const scope = err?.scope === 'per-model' ? 'per-model' : 'global';
    try { c.logger?.error?.(`token-stats D1 ${scope} persist failed: ${err?.message || err}`); } catch { /* never throw */ }
  });
  const ctx = c.ctx;
  if (ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(task); } catch { task.catch(() => {}); }
  } else {
    // No ExecutionContext (unit tests): fire-and-forget with a swallow.
    task.catch(() => {});
  }
}

// Record the real request outcome first. Tier 1 learns ONLY from real business
// requests: success drives half-open recovery and (on an affinity escape) moves
// the session to the winning account. Tier 2/3 keep their node-state path.
// There is NO background probe anymore — probes were Tier-1-only and have been
// removed entirely from the scheduling path.
/**
 * @param {AttemptContext} c
 * @param {RuntimeNode} node
 * @param {number} latencyMs
 */
export function recordNodeSuccess(c, node, latencyMs) {
  if (node.tier === 'tier-1') {
    recordTier1Success(node.id, c.state?.requestedModel);
    releaseTier1Slot(node.id, c.tier1ReleaseToken);
    bumpNodeCounters(node.id, { requests: 1, successes: 1 });
    // KV writes happen only for a cold session or an approved migration, and
    // only after the selected account completed a real request successfully.
    if (c.tier1UpdateAffinity && c.tier1Session) {
      writeTier1Affinity(c.env, c.ctx, c.tier1Session, node.id);
    }
    return;
  }
  recordSuccess(node.id, latencyMs, c.state?.requestedModel);
}

// Node-layer stream tracking: node outcome recording + stream-end telemetry.
// The client-facing layer (gateway-stats.mjs trackClientResponse) never passes the
// telemetry callbacks, so stream counters count each stream exactly once.
/**
 * @param {AttemptContext} c
 * @param {RuntimeNode} node
 * @param {number} latencyMs
 */
export function makeNodeStreamTrack(c, node, latencyMs) {
  const tier1 = node.tier === 'tier-1';
  return {
    onSuccess: () => recordNodeSuccess(c, node, latencyMs),
    // Field evidence (NVIDIA-hosted stalls mid-generation): 2s let a stalling
    // node straight back into rotation. 60s matches the rate-limit cooldown —
    // long enough to push repeat offenders out of candidate ordering without
    // permanently discarding a node that had one transient blip.
    // Tier 1 needs the concrete interruption reason supplied to onStreamEnd,
    // so its failure state and release happen there. Tier 2/3 keep the existing
    // recordFailure path unchanged.
    onFailure: () => {
      if (!tier1) recordFailure(node.id, { counted: true, cooldownMs: 60_000, reason: 'stream_interrupted' });
    },
    onNeutral: () => tier1
      ? releaseTier1Slot(node.id, c.tier1ReleaseToken)
      : recordNeutralEnd(node.id),
    onStreamStart: () => recordStreamStart(),
    /** @param {string} outcome @param {{ reason: string, durationMs: number, chunkCount: number, receivedBytes: number, completionMarkerSeen: boolean }} d */
    onStreamEnd: (outcome, d) => {
      if (outcome === 'completed') { recordStreamCompleted(); return; }
      if (outcome !== 'interrupted') return; // neutral (client abort) is not counted
      recordStreamInterrupted(d.reason);
      if (tier1) {
        applyTier1Outcome(node.id, c.state?.requestedModel,
          classifyTier1Failure({ kind: 'stream_interrupted', streamReason: d.reason }));
        releaseTier1Slot(node.id, c.tier1ReleaseToken);
        bumpNodeCounters(node.id, { requests: 1, failures: 1 });
      } else {
        applyHealthPenalty(node.id, 'stream');
      }
      c.logger.info(
        `[stream-interrupted] node=${node.id} provider=${node.provider}`
        + ` protocol=${c.upstreamProtocol ?? node.protocol} surface=${c.surface ?? node.surfaces?.[0] ?? ''}`
        + ` model=${c.requestedModel}->${upstreamModelOf(node, c.requestedModel)}`
        + ` reason=${d.reason} duration_ms=${d.durationMs} chunks=${d.chunkCount}`
        + ` received_bytes=${d.receivedBytes} completion_marker=${d.completionMarkerSeen}`,
      );
    },
  };
}
