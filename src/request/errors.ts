// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Gateway error-response builders. Every terminal client-facing error goes
// through here so protocol shape, topology hiding, Retry-After and
// x-should-retry semantics stay consistent across routes.

import { corsHeaders, shouldNotRetryHeaders, trimDiagnostic } from '../protocol/http.ts';
import { anthropicErrorTypeForStatus } from '../protocol/anthropic.ts';
import { responsesErrorResponse } from '../protocol/responses/index.ts';
import { getCooldownRemainingMs, getModelCooldownRemainingMs } from '../reliability/node-state.ts';
import { tier1BlockingWaitMs } from '../reliability/tier1-state.ts';
import { supportsRequest } from '../scheduler/scheduler.ts';
import { TIER_ORDER } from './router.ts';
import { modelFallbackCandidates } from './model-fallback.ts';
import type { RequestDescriptor, LoopState } from '../types/request.ts';
import { KIND as FAILURE_KIND } from '../reliability/classify.ts';
import type { RuntimeNode } from '../types/node.ts';

export function gatewayError(
  request: Request,
  env: Record<string, unknown>,
  route: string,
  status: number,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Response {
  if (route === 'anthropic_messages' || route === 'anthropic_count_tokens') {
    return new Response(JSON.stringify({
      type: 'error',
      error: { type: anthropicErrorTypeForStatus(status), message, ...(details ? { details } : {}) },
    }), {
      status,
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        'cache-control': 'no-store',
        'request-id': requestId || '',
        'x-request-id': requestId || '',
        ...(extraHeaders || {}),
        ...shouldNotRetryHeaders(status),
        ...corsHeaders(request, env),
      },
    });
  }
  if (route === 'openai_responses') {
    return responsesErrorResponse(request, env, status, message, requestId, extraHeaders);
  }
  return new Response(JSON.stringify({ error: { message, ...(details ? { details } : {}) } }), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'x-request-id': requestId || '',
      ...(extraHeaders || {}),
      ...shouldNotRetryHeaders(status),
      ...corsHeaders(request, env),
    },
  });
}

export function buildBudgetExhaustedResponse(
  request: Request,
  env: Record<string, unknown>,
  route: string,
  requestId: string,
  requestedModel: string,
  state: LoopState,
  exposeUpstreamInfo: boolean,
): Response {
  const details = {
    requested_model: requestedModel,
    attempts: state.logicalAttempts,
    dispatches: state.dispatches,
    hedges: state.hedges,
    ...(state.failureKinds && Object.keys(state.failureKinds).length
      ? { failure_kinds: state.failureKinds }
      : {}),
    ...(exposeUpstreamInfo && state.attempts.length ? { attempts_detail: state.attempts } : {}),
  };
  return gatewayError(
    request,
    env,
    route,
    504,
    `Gateway failover budget exhausted after ${state.logicalAttempts} attempt(s).`,
    requestId,
    details,
  );
}

export function buildExhaustedResponse(
  request: Request,
  env: Record<string, unknown>,
  route: string,
  requestId: string,
  requestedModel: string,
  state: LoopState,
  tiers: Record<number, RuntimeNode[]>,
  exposeUpstreamInfo: boolean,
  reqDescriptor: RequestDescriptor,
  knownModels?: ReadonlySet<string>,
  retryableFamilyExhaustion: boolean = false,
): Response {
  const last = state.attempts[state.attempts.length - 1];
  const nothingAttempted = state.attempts.length === 0;
  const knownModels_ = knownModels ?? state.knownModels;
  const now = Date.now();

  let status: number;
  let message: string;
  let retryAfterSec: number | undefined;

  if (nothingAttempted) {
    if (state.tier1ExhaustionReason === 'deadline_too_small') {
      status = 503;
      message = 'The remaining request deadline is too short for another safe upstream attempt.';
      retryAfterSec = 1;
    } else {
      // With static RPM/concurrency admission removed, a statically reachable
      // route that dispatched nothing is blocked only by live reliability
      // state: cooldown, circuit/half-open recovery, adaptive-429 recovery or
      // an explicit quota reset. Report that as temporary unavailability and
      // expose the earliest real recovery when one is known.
      status = 429;
      message = 'All eligible nodes are temporarily unavailable.';
      retryAfterSec = earliestBlockingRetryAfterSec(tiers, reqDescriptor, now, knownModels_);
    }
  } else {
    status = terminalStatus(state.failureKinds) ?? (last?.status === 429 ? 429 : 502);
    message = `All nodes failed for model "${requestedModel}".`;

    if (retryableFamilyExhaustion && familyFailureSetIsRetryable(state.failureKinds)) {
      const originalStatus = status;
      status = 503;
      message = `Compatible model capacity is temporarily unavailable for "${requestedModel}". Retry shortly.`;
      retryAfterSec = originalStatus === 429
        ? earliestFamilyBlockingRetryAfterSec(tiers, reqDescriptor, requestedModel, now, knownModels_) ?? 1
        : 1;
      state.logger.info('model-family exhaustion mapped to retryable capacity response', {
        request_id: requestId,
        requested_model: requestedModel,
        upstream_status: originalStatus,
        client_status: status,
        retry_after_seconds: retryAfterSec,
        failure_kinds: state.failureKinds,
      });
    }

    if (status === 429) {
      retryAfterSec = earliestBlockingRetryAfterSec(tiers, reqDescriptor, now, knownModels_);
      if (retryAfterSec === undefined && state.failureKinds?.rate_limit_global) {
        retryAfterSec = distributedWindowRetryAfterSec(now);
      }
    }
  }

  const details = {
    requested_model: requestedModel,
    attempts: state.logicalAttempts,
    dispatches: state.dispatches,
    hedges: state.hedges,
    ...(state.failureKinds && Object.keys(state.failureKinds).length
      ? { failure_kinds: state.failureKinds }
      : {}),
    ...(exposeUpstreamInfo && state.attempts.length ? { attempts_detail: state.attempts } : {}),
  };

  return gatewayError(
    request,
    env,
    route,
    status,
    message,
    requestId,
    details,
    retryAfterSec ? { 'retry-after': String(retryAfterSec) } : undefined,
  );
}

function earliestBlockingRetryAfterSec(
  tiers: Record<number, RuntimeNode[]>,
  reqDescriptor: RequestDescriptor,
  now: number = Date.now(),
  knownModels?: ReadonlySet<string>,
): number | undefined {
  let minMs = Infinity;
  for (const tier of TIER_ORDER) {
    for (const node of tiers[tier] ?? []) {
      if (!supportsRequest(node, reqDescriptor, knownModels)) continue;
      const wait = blockingWaitMs(node, reqDescriptor.model, now);
      if (wait < minMs) minMs = wait;
    }
  }
  if (!Number.isFinite(minMs)) return undefined;
  return Math.max(1, Math.ceil(minMs / 1000));
}

function earliestFamilyBlockingRetryAfterSec(
  tiers: Record<number, RuntimeNode[]>,
  reqDescriptor: RequestDescriptor,
  requestedModel: string,
  now: number,
  knownModels?: ReadonlySet<string>,
): number | undefined {
  const models = knownModels
    ? modelFallbackCandidates(requestedModel, knownModels)
    : [requestedModel];
  let minSec = Infinity;
  for (const model of models) {
    const wait = earliestBlockingRetryAfterSec(tiers, { ...reqDescriptor, model }, now, knownModels);
    if (wait !== undefined && wait < minSec) minSec = wait;
  }
  return Number.isFinite(minSec) ? minSec : undefined;
}

function blockingWaitMs(node: RuntimeNode, requestedModel: string, now: number): number {
  if (node.tier === 'tier-1') return tier1BlockingWaitMs(node, requestedModel, now);
  const nodeCooldown = getCooldownRemainingMs(node.id, now);
  if (nodeCooldown > 0) return nodeCooldown;
  const modelCooldown = getModelCooldownRemainingMs(node.id, requestedModel, now);
  if (modelCooldown > 0) return modelCooldown;
  return Infinity;
}

function distributedWindowRetryAfterSec(now: number = Date.now()): number {
  return Math.max(1, Math.ceil((60_000 - (now % 60_000)) / 1000));
}

export function buildClientErrorResponse(
  request: Request,
  env: Record<string, unknown>,
  route: string,
  requestId: string,
  requestedModel: string,
  status: number,
  errorText: string | Uint8Array,
  state: LoopState,
  exposeUpstreamInfo: boolean,
): Response {
  const detail = extractErrorMessage(errorText) || `Upstream returned HTTP ${status}.`;
  const attemptsDetail = exposeUpstreamInfo && state.attempts.length
    ? { attempts_detail: state.attempts.slice(-1) }
    : {};

  if (route === 'anthropic_messages') {
    return new Response(JSON.stringify({
      type: 'error',
      error: { type: anthropicErrorTypeForStatus(status), message: detail },
    }), {
      status,
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        'cache-control': 'no-store',
        'request-id': requestId,
        'x-request-id': requestId,
        ...shouldNotRetryHeaders(status),
        ...corsHeaders(request, env),
      },
    });
  }
  if (route === 'openai_responses') {
    return responsesErrorResponse(request, env, status, detail, requestId);
  }
  return new Response(JSON.stringify({
    error: {
      message: detail,
      details: {
        requested_model: requestedModel,
        attempts: state.logicalAttempts,
        dispatches: state.dispatches,
        hedges: state.hedges,
        ...attemptsDetail,
      },
    },
  }), {
    status,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
      ...shouldNotRetryHeaders(status),
      ...corsHeaders(request, env),
    },
  });
}

function extractErrorMessage(text: string | Uint8Array | null | undefined): string {
  const raw = String(text || '').trim();
  if (!raw) return '';
  try {
    const json = JSON.parse(raw);
    return json?.error?.message || json?.message || trimDiagnostic(raw, 300);
  } catch {
    return trimDiagnostic(raw, 300);
  }
}

function familyFailureSetIsRetryable(failureKinds?: Partial<Record<string, number>>): boolean {
  const observed = Object.entries(failureKinds || {}).filter(([, count]) => (count || 0) > 0);
  if (observed.length === 0) return false;
  const retryableKinds = new Set<string>([
    FAILURE_KIND.RATE_LIMIT,
    FAILURE_KIND.RATE_LIMIT_GLOBAL,
    FAILURE_KIND.SERVER,
    FAILURE_KIND.NETWORK,
    FAILURE_KIND.HEADERS_TIMEOUT,
    FAILURE_KIND.FIRST_EVENT_TIMEOUT,
    FAILURE_KIND.STREAM_INTERRUPTED,
  ]);
  return observed.every(([kind]) => retryableKinds.has(kind));
}

function dominantKind(failureKinds?: Partial<Record<string, number>>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [kind, count] of Object.entries(failureKinds || {})) {
    if ((count || 0) > bestCount) {
      best = kind;
      bestCount = count || 0;
    }
  }
  return best;
}

function terminalStatus(failureKinds?: Partial<Record<string, number>>): number | null {
  const dominant = dominantKind(failureKinds);
  if (!dominant) return null;
  if (dominant === FAILURE_KIND.RATE_LIMIT || dominant === FAILURE_KIND.RATE_LIMIT_GLOBAL) return 429;
  if (dominant === FAILURE_KIND.HEADERS_TIMEOUT || dominant === FAILURE_KIND.FIRST_EVENT_TIMEOUT) return 504;
  return 502;
}
