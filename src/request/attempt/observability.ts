// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
// Part of src/request/attempt.ts (behavior-preserving split); see
// attempt/index.ts for the module map.

// observability.ts - post-outcome recording for one physical upstream attempt.
// Delivered-response token statistics and physical-attempt token statistics are
// intentionally separate: failed/fallback/hedge work must never fabricate
// successful model-status evidence, but it still belongs in upstream cost
// accounting when usage is reported.

import {
  recordSuccess, recordNeutralEnd, applyHealthPenalty,
  bumpNodeCounters, recordFailure,
} from '../../reliability/node-state.ts';
import {
  releaseTier1Slot,
  recordTier1Ttft, recordTier1Success, applyTier1Outcome, classifyTier1Failure,
  recordTier1ProviderModelSuccess, getTier1Account,
} from '../../reliability/tier1-state.ts';
import { clearAdaptive429State } from '../../reliability/adaptive-429.ts';
import { classifyStreamInterrupted } from '../../reliability/classify.ts';
import { writeTier1Affinity } from '../../scheduler/tier1-affinity.ts';
import {
  recordStreamStart, recordStreamCompleted, recordStreamInterrupted,
  gatewayStats,
} from '../../observability/gateway-stats.ts';
import { recordTokenUsage, mergeReportedUsage, normalizeTokenUsage } from '../../observability/token-usage.ts';
import { persistTokenUsage, persistUpstreamAttemptUsage } from '../../observability/token-usage-store.ts';
import { upstreamModelOf } from '../response-helpers.ts';
import type { AttemptContext } from '../../types/request.ts';
import type { RuntimeNode } from '../../types/node.ts';

const observedAttemptUsage = new WeakMap<object, unknown>();
const settledAttemptUsage = new WeakSet<object>();

export function observeUpstreamAttemptUsage(c: AttemptContext, usage: unknown): void {
  if (!c || settledAttemptUsage.has(c as object) || usage == null) return;
  const merged = mergeReportedUsage(observedAttemptUsage.get(c as object), usage);
  if (normalizeTokenUsage(merged)) observedAttemptUsage.set(c as object, merged);
}

export function recordTier1NonStreamTtft(c: AttemptContext, node: RuntimeNode, data: unknown, isMeaningful: (data: unknown) => boolean): void {
  if (node.tier !== 'tier-1' || !isMeaningful(data)) return;
  c.ttftMs = Date.now() - (c.attemptStartMs ?? Date.now());
  recordTier1Ttft(node.id, c.state.requestedModel, c.ttftMs);
}

export function recordTokens(c: AttemptContext, node: RuntimeNode, usage: unknown): void {
  if (settledAttemptUsage.has(c as object)) return;
  observeUpstreamAttemptUsage(c, usage);
  settledAttemptUsage.add(c as object);
  const effectiveModel = upstreamModelOf(node, c.requestedModel);
  recordTokenUsage({ model: effectiveModel, tier: node.tier, provider: node.provider, nodeId: node.id, usage });
  scheduleD1TokenPersist(c, usage, effectiveModel);
}

export function recordUndeliveredUpstreamAttempt(c: AttemptContext, node: RuntimeNode, usage?: unknown): void {
  if (settledAttemptUsage.has(c as object)) return;
  if (usage !== undefined) observeUpstreamAttemptUsage(c, usage);
  settledAttemptUsage.add(c as object);
  const observed = observedAttemptUsage.get(c as object) ?? null;
  // Some reliability unit tests intentionally construct the historical minimal
  // AttemptContext shape without reqDescriptor. Falling back to requestedModel
  // preserves that compatibility and is also the correct native-pass identity.
  const routedModel = c.reqDescriptor?.model ?? c.requestedModel;
  const effectiveModel = upstreamModelOf(node, routedModel);
  const task = persistUpstreamAttemptUsage(c.env, observed, Date.now(), effectiveModel).catch((err) => {
    const scope = String(err?.scope || '').includes('model') ? 'upstream-model' : 'upstream-global';
    try { c.logger?.error?.(`upstream token-stats D1 ${scope} persist failed: ${err?.message || err}`); } catch { /* fail-open */ }
  });
  scheduleBackground(c, task);
}

function scheduleD1TokenPersist(c: AttemptContext, usage: unknown, effectiveModel?: string): void {
  const modelForPersist = effectiveModel ?? c.requestedModel;
  const task = persistTokenUsage(c.env, usage, Date.now(), modelForPersist, c.ttftMs ?? null).catch((err) => {
    const scope = err?.scope === 'per-model' ? 'per-model' : 'global';
    try { c.logger?.error?.(`token-stats D1 ${scope} persist failed: ${err?.message || err}`); } catch { /* never throw */ }
  });
  scheduleBackground(c, task);
}

function scheduleBackground(c: AttemptContext, task: Promise<unknown>): void {
  const ctx = c.ctx;
  if (ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(task); } catch { task.catch(() => {}); }
  } else {
    task.catch(() => {});
  }
}

export function recordNodeSuccess(c: AttemptContext, node: RuntimeNode, latencyMs: number): void {
  if (node.tier === 'tier-1') {
    const logicalModel = c.state.requestedModel;
    recordTier1Success(node.id, logicalModel);
    if (getTier1Account(node.id).consecutiveRateLimits === 0) clearAdaptive429State(node.provider, node.id);
    recordTier1ProviderModelSuccess(node.provider, upstreamModelOf(node, logicalModel), node.id);
    releaseTier1Slot(node.id, c.tier1ReleaseToken);
    bumpNodeCounters(node.id, { requests: 1, successes: 1 });
    if (c.tier1UpdateAffinity && c.tier1Session) writeTier1Affinity(c.env, c.ctx, c.tier1Session, node.id);
    return;
  }
  recordSuccess(node.id, latencyMs, c.state?.requestedModel);
}

export function makeNodeStreamTrack(
  c: AttemptContext,
  node: RuntimeNode,
  latencyMs: number,
  { observeStreamUsage = true }: { observeStreamUsage?: boolean } = {},
) {
  const tier1 = node.tier === 'tier-1';
  return {
    // trackStreamResponse invokes this for every terminal stream outcome. A
    // completed winner is persisted by recordTokens/onUsage below, so only
    // failure/neutral paths need the upstream-only writer here. Converted
    // streams may contain synthetic client-facing usage; those call sites turn
    // observation off and feed the RAW upstream usage through their converter
    // callback instead.
    onAttemptUsage: (usage: unknown, outcome: 'success' | 'failure' | 'neutral') => {
      if (observeStreamUsage && usage != null) observeUpstreamAttemptUsage(c, usage);
      if (outcome !== 'success') recordUndeliveredUpstreamAttempt(c, node);
    },
    onSuccess: () => {
      recordNodeSuccess(c, node, latencyMs);
      gatewayStats.activeRequests = Math.max(0, gatewayStats.activeRequests - 1);
      gatewayStats.successes++;
    },
    onFailure: () => {
      if (!tier1) {
        const classification = classifyStreamInterrupted();
        recordFailure(node.id, { counted: classification.counted, cooldownMs: classification.cooldownMs, reason: classification.kind });
      }
      gatewayStats.activeRequests = Math.max(0, gatewayStats.activeRequests - 1);
      gatewayStats.failures++;
    },
    onNeutral: () => {
      if (tier1) releaseTier1Slot(node.id, c.tier1ReleaseToken);
      else recordNeutralEnd(node.id);
      gatewayStats.activeRequests = Math.max(0, gatewayStats.activeRequests - 1);
      gatewayStats.cancellations++;
    },
    onStreamStart: () => recordStreamStart(),
    onStreamEnd: (outcome: string, d: { reason: string | null, durationMs: number, chunkCount: number, receivedBytes: number, completionMarkerSeen: boolean }) => {
      if (outcome === 'completed') { recordStreamCompleted(); return; }
      if (outcome !== 'interrupted') return;
      recordStreamInterrupted(d.reason);
      if (tier1) {
        applyTier1Outcome(node.id, c.state?.requestedModel,
          classifyTier1Failure({ kind: classifyStreamInterrupted().kind, streamReason: d.reason }));
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
