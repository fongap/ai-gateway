// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
// Part of src/request/attempt.js (behavior-preserving split); see
// attempt/index.js for the module map.

// outcome.js - AttemptOutcome construction and accounting: failure /
// rotate / stop outcomes, the logical-attempt vs dispatch charge rules,
// pre-dispatch neutral ends, and the single per-dispatch completion log.

import {
  recordNeutralEnd, rollbackRpmBucket, recordModelMissing,
  applyHealthPenalty, recordFailure, bumpNodeCounters,
} from '../../reliability/node-state.js';
import {
  releaseTier1Slot,
  applyTier1Outcome, classifyTier1Failure,
  rollbackTier1Rpm,
} from '../../reliability/tier1-state.js';
import { trimDiagnostic } from '../../protocol/http.js';
import { upstreamModelOf } from '../response-helpers.js';

export function rotateWithNeutralEnd(state, node, reason, c = {}, preDispatch = false) {
  state.attempted.add(node.id);
  // Pre-dispatch neutrals (invalid base URL) never reached an upstream, so they
  // do not consume any budget — no dispatch/attempt charge, and the outcome
  // reports budgetCharged:false exactly like the rate-limiter deny.
  if (!preDispatch) {
    state.dispatches++;
    if (!c.hedgedAttempt) state.logicalAttempts++;
  }
  if (node.tier === 'tier-1') {
    releaseTier1Slot(node.id, c.tier1ReleaseToken);
    if (preDispatch) rollbackTier1Rpm(node.id);
    else bumpNodeCounters(node.id, { requests: 1 });
  } else {
    recordNeutralEnd(node.id);
    // Pre-dispatch neutrals also never touched the network, so the RPM reservation
    // acquireSlot made must be returned to the bucket — otherwise a structurally
    // broken node silently burns its own per-minute RPM quota on traffic it never
    // sent. Post-dispatch neutrals (200-with-non-json) keep the charge: the
    // upstream WAS contacted.
    if (preDispatch) rollbackRpmBucket(node.id);
  }
  noteFailure(state, reason);
  state.logger.info(
    `dispatch request=${c.requestId ?? state.requestId} logical_attempt=${preDispatch ? state.logicalAttempts + 1 : state.logicalAttempts}/${state.maxAttempts}`
    + ` dispatch=${state.dispatches} node=${node.id} provider=${node.provider}`
    + ` protocol=${c.upstreamProtocol ?? node.protocol} surface=${c.surface ?? ''} tier=${node.tier ?? ''}`
    + ` model=${state.requestedModel}->${upstreamModelOf(node, state.requestedModel)}`
    + ` hedged=${!!(c.hedgedAttempt || c.hedgedWithTwin)} kind=${reason} status=0 counted=false`,
  );
  state.attempts.push({ attempt: state.logicalAttempts + (preDispatch ? 1 : 0), dispatch: state.dispatches, node_id: node.id, status: 0, kind: reason, hedged: !!(c.hedgedAttempt || c.hedgedWithTwin) });
  return preDispatch ? { rotate: true, budgetCharged: false, kind: reason } : { rotate: true, kind: reason };
}

// Aggregate failure-kind counter for the exhausted response. Kinds alone (no
// node ids / no ordering) are safe to expose to clients by default and answer
// the only question that matters when everything failed: HOW did it fail?
export function noteFailure(state, kind) {
  state.failureKinds[kind] = (state.failureKinds[kind] || 0) + 1;
}

// Record a classified attempt outcome exactly once. `c` is the dispatch
// context (attemptNode args): its hedgedAttempt / hedgedWithTwin flags decide
// charging and the hedged log field, headersMs feeds the timing fields.
//   * dispatches counts every real upstream dispatch (never a pre-dispatch deny);
//   * logicalAttempts counts the logical attempt the dispatch belongs to — a
//     hedge twin belongs to its primary's attempt and does not increment it.
/**
 * @param {Record<string, any>} state
 * @param {Record<string, any>} node
 * @param {Record<string, any>} classification
 * @param {Record<string, any>} c
 * @param {{latencyMs?: number, ttftWaitMs?: number, status?: number, diagnostic?: string}} [opts]
 */
export function recordOutcome(state, node, classification, c, { latencyMs = -1, ttftWaitMs, status = 0, diagnostic } = {}) {
  state.attempted.add(node.id);
  state.dispatches++;
  if (!c?.hedgedAttempt) state.logicalAttempts++;
  const hedged = !!(c?.hedgedAttempt || c?.hedgedWithTwin);
  const headersMs = c?.headersMs ?? (latencyMs >= 0 ? latencyMs : undefined);

  if (node.tier === 'tier-1') {
    // Tier 1 owns its own per-(account,model) failure state machine. The
    // shared classify.js outcome is mapped to a Tier 1 scope/cooldown; 429
    // defaults to MODEL scope with a scope_ambiguous diagnostic flag when no
    // provider-specific rule disambiguated it.
    releaseTier1Slot(node.id, c.tier1ReleaseToken);
    if (classification.action === 'neutral') {
      bumpNodeCounters(node.id, { requests: 1 });
    } else {
      const t1Class = classifyTier1Failure(classification, { retryAfterMs: classification.retryAfterMs || 0 });
      applyTier1Outcome(node.id, state.requestedModel, t1Class);
      bumpNodeCounters(node.id, { requests: 1, failures: 1 });
    }
  } else if (classification.modelScoped) {
    // A 404 "model not found" is a (node, model) mapping mismatch, not a node
    // health issue: cool the PAIR only, leave the node healthy for its other
    // models, do not penalize health, do not feed the circuit.
    recordModelMissing(node.id, state.requestedModel, classification.cooldownMs || 0);
  } else if (classification.action === 'neutral') {
    recordNeutralEnd(node.id);
  } else {
    applyHealthPenalty(node.id, classification.kind);
    recordFailure(node.id, { counted: classification.counted, cooldownMs: classification.cooldownMs || 0, reason: classification.kind });
  }

  noteFailure(state, classification.kind);
  state.logger.info(
    `dispatch request=${c?.requestId ?? state.requestId} logical_attempt=${state.logicalAttempts}/${state.maxAttempts}`
    + ` dispatch=${state.dispatches} node=${node.id} provider=${node.provider}`
    + ` protocol=${c?.upstreamProtocol ?? node.protocol} surface=${c?.surface ?? ''} tier=${node.tier}`
    + ` model=${state.requestedModel}->${upstreamModelOf(node, state.requestedModel)}`
    + ` hedged=${hedged} kind=${classification.kind} status=${status} counted=${classification.counted}`
    + ` headers_ms=${headersMs ?? -1}${ttftWaitMs !== undefined ? ` ttft_wait_ms=${ttftWaitMs}` : ''}`
    + ` latency_ms=${latencyMs}`
    + `${diagnostic && c?.exposeUpstreamInfo ? ` detail=${trimDiagnostic(diagnostic, 200)}` : ''}`,
  );

  const record = {
    attempt: state.logicalAttempts, dispatch: state.dispatches, node_id: node.id,
    provider: node.provider, protocol: c?.upstreamProtocol ?? node.protocol, surface: c?.surface,
    status, kind: classification.kind, hedged,
  };
  if (headersMs !== undefined && headersMs >= 0) record.headers_ms = headersMs;
  if (ttftWaitMs !== undefined && ttftWaitMs >= 0) record.ttft_wait_ms = ttftWaitMs;
  if (latencyMs >= 0) record.latency_ms = latencyMs;
  if (c?.exposeUpstreamInfo && diagnostic) record.detail = trimDiagnostic(diagnostic, 300);
  state.attempts.push(record);
}
