// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Attempt outcome accounting. Logical attempts and real upstream dispatches
// are separate budgets; pre-dispatch failures release their scheduler claim
// without charging either budget.

import {
  recordNeutralEnd,
  recordModelMissing,
  applyHealthPenalty,
  recordFailure,
  bumpNodeCounters,
} from '../../reliability/node-state.ts';
import {
  releaseTier1Slot,
  applyTier1Outcome,
  classifyTier1Failure,
  recordTier1ProviderModelRateLimit,
} from '../../reliability/tier1-state.ts';
import { nextAdaptive429CooldownMs } from '../../reliability/adaptive-429.ts';
import { KIND } from '../../reliability/classify.ts';
import type { FailureClassification, FailureKind } from '../../reliability/classify.ts';
import { trimDiagnostic } from '../../protocol/http.ts';
import { upstreamModelOf } from '../response-helpers.ts';
import type { LoopState, AttemptContext, AttemptOutcome } from '../../types/request.ts';
import type { RuntimeNode } from '../../types/node.ts';

export function rotateWithNeutralEnd(
  state: LoopState,
  node: RuntimeNode,
  reason: FailureKind,
  c: Partial<AttemptContext> = {},
  preDispatch: boolean = false,
): AttemptOutcome {
  state.attempted.add(node.id);
  if (!preDispatch) {
    state.dispatches++;
    if (!c.hedgedAttempt) state.logicalAttempts++;
  }
  if (node.tier === 'tier-1') {
    releaseTier1Slot(node.id, c.tier1ReleaseToken);
    if (!preDispatch) bumpNodeCounters(node.id, { requests: 1 });
  } else {
    recordNeutralEnd(node.id);
  }
  noteFailure(state, reason);
  state.logger.info(
    `dispatch request=${c.requestId ?? state.requestId}`
    + ` logical_attempt=${preDispatch ? state.logicalAttempts + 1 : state.logicalAttempts}/${state.maxAttempts}`
    + ` dispatch=${state.dispatches} node=${node.id} provider=${node.provider}`
    + ` protocol=${c.upstreamProtocol ?? node.protocol} surface=${c.surface ?? ''} tier=${node.tier ?? ''}`
    + ` model=${state.requestedModel}->${upstreamModelOf(node, state.requestedModel)}`
    + ` hedged=${!!(c.hedgedAttempt || c.hedgedWithTwin)} kind=${reason} status=0 counted=false`,
  );
  state.attempts.push({
    attempt: state.logicalAttempts + (preDispatch ? 1 : 0),
    dispatch: state.dispatches,
    node_id: node.id,
    status: 0,
    kind: reason,
    hedged: !!(c.hedgedAttempt || c.hedgedWithTwin),
  });
  return preDispatch
    ? { rotate: true, budgetCharged: false, kind: reason }
    : { rotate: true, kind: reason };
}

export function noteFailure(state: LoopState, kind: FailureKind): void {
  state.failureKinds[kind] = (state.failureKinds[kind] || 0) + 1;
}

export function recordOutcome(
  state: LoopState,
  node: RuntimeNode,
  classification: FailureClassification,
  c: AttemptContext,
  {
    latencyMs = -1,
    ttftWaitMs,
    status = 0,
    diagnostic,
  }: { latencyMs?: number, ttftWaitMs?: number, status?: number, diagnostic?: string } = {},
): void {
  state.attempted.add(node.id);
  state.dispatches++;
  if (!c.hedgedAttempt) state.logicalAttempts++;
  const hedged = !!(c.hedgedAttempt || c.hedgedWithTwin);
  const headersMs = c.headersMs ?? (latencyMs >= 0 ? latencyMs : undefined);

  if (node.tier === 'tier-1') {
    releaseTier1Slot(node.id, c.tier1ReleaseToken);
    if (classification.action === 'neutral') {
      bumpNodeCounters(node.id, { requests: 1 });
    } else {
      const upstreamModel = upstreamModelOf(node, state.requestedModel);
      let tier1RetryAfterMs = classification.retryAfterMs || 0;
      if (classification.kind === KIND.RATE_LIMIT) {
        recordTier1ProviderModelRateLimit(node.provider, upstreamModel, node.id);
        tier1RetryAfterMs = nextAdaptive429CooldownMs(
          node.provider,
          node.id,
          classification.retryAfterMs || 0,
        );
      }
      const tier1Class = classifyTier1Failure(classification, { retryAfterMs: tier1RetryAfterMs });
      const tier1ModelKey = classification.kind === KIND.MODEL_MISSING
        ? upstreamModel
        : state.requestedModel;
      applyTier1Outcome(node.id, tier1ModelKey, tier1Class);
      bumpNodeCounters(node.id, { requests: 1, failures: 1 });
    }
  } else if (classification.modelScoped) {
    recordModelMissing(node.id, state.requestedModel, classification.cooldownMs || 0);
  } else if (classification.action === 'neutral') {
    recordNeutralEnd(node.id);
  } else {
    applyHealthPenalty(node.id, classification.kind);
    recordFailure(node.id, {
      counted: classification.counted,
      cooldownMs: classification.cooldownMs || 0,
      reason: classification.kind,
    });
  }

  noteFailure(state, classification.kind);
  state.logger.info(
    `dispatch request=${c.requestId ?? state.requestId} logical_attempt=${state.logicalAttempts}/${state.maxAttempts}`
    + ` dispatch=${state.dispatches} node=${node.id} provider=${node.provider}`
    + ` protocol=${c.upstreamProtocol ?? node.protocol} surface=${c.surface ?? ''} tier=${node.tier}`
    + ` model=${state.requestedModel}->${upstreamModelOf(node, state.requestedModel)}`
    + ` hedged=${hedged} kind=${classification.kind} status=${status} counted=${classification.counted}`
    + ` headers_ms=${headersMs ?? -1}${ttftWaitMs !== undefined ? ` ttft_wait_ms=${ttftWaitMs}` : ''}`
    + ` latency_ms=${latencyMs}`
    + `${diagnostic && c.exposeUpstreamInfo ? ` detail=${trimDiagnostic(diagnostic, 200)}` : ''}`,
  );

  const record: Record<string, unknown> = {
    attempt: state.logicalAttempts,
    dispatch: state.dispatches,
    node_id: node.id,
    provider: node.provider,
    protocol: c.upstreamProtocol ?? node.protocol,
    surface: c.surface,
    status,
    kind: classification.kind,
    hedged,
  };
  if (headersMs !== undefined && headersMs >= 0) record.headers_ms = headersMs;
  if (ttftWaitMs !== undefined && ttftWaitMs >= 0) record.ttft_wait_ms = ttftWaitMs;
  if (latencyMs >= 0) record.latency_ms = latencyMs;
  if (c.exposeUpstreamInfo && diagnostic) record.detail = trimDiagnostic(diagnostic, 300);
  state.attempts.push(record);
}
