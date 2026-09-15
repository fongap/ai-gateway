// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Gateway error-response builders. Every terminal client-facing error goes
// through here so protocol shape, topology hiding, Retry-After and
// x-should-retry semantics stay consistent across routes.
//
// Topology policy: by default error bodies expose only requested_model and the
// attempt COUNT. The per-attempt internal sequence (node ids, kinds, latency,
// upstream diagnostics) is attached only when the caller passes
// `exposeUpstreamInfo` (EXPOSE_UPSTREAM_INFO=true).

import { corsHeaders, shouldNotRetryHeaders, trimDiagnostic } from '../protocol/http.ts';
import { anthropicErrorTypeForStatus } from '../protocol/anthropic.ts';
import { responsesErrorResponse } from '../protocol/responses/index.ts';
import { getCooldownRemainingMs, getModelCooldownRemainingMs } from '../reliability/node-state.ts';
import { tier1BlockingWaitMs, tier1HasDeferredCapacity } from '../reliability/tier1-state.ts';
import { supportsRequest } from '../scheduler/scheduler.ts';
import { TIER_ORDER } from './router.ts';
import { modelFallbackCandidates } from './model-fallback.ts';
import type { RequestDescriptor, LoopState } from '../types/request.ts';
import { KIND as FAILURE_KIND } from '../reliability/classify.ts';
import type { RuntimeNode } from '../types/node.ts';

const GATEWAY_ERROR_CODE = Object.freeze({
  FAILOVER_BUDGET_EXHAUSTED: 'gateway_failover_budget_exhausted',
  NO_DISPATCHABLE_NODE: 'gateway_no_dispatchable_node',
  ATTEMPT_BUDGET_EXHAUSTED: 'gateway_attempt_budget_exhausted',
  UPSTREAM_EXHAUSTED: 'gateway_upstream_exhausted',
});

function responsesDiagnosticHeaders(
  details?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...(extraHeaders || {}) };
  if (details) {
    for (const [field, header] of [
      ['attempts', 'x-gateway-attempts'],
      ['dispatches', 'x-gateway-dispatches'],
      ['hedges', 'x-gateway-hedges'],
    ] as const) {
      const value = details[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        headers[header] = String(Math.trunc(value));
      }
    }
    const failureKinds = formatFailureKinds(details.failure_kinds);
    if (failureKinds) headers['x-gateway-failure-kinds'] = failureKinds;
    else if (typeof details.failure_kind === 'string' && details.failure_kind) {
      headers['x-gateway-failure-kinds'] = `${sanitizeFailureKind(details.failure_kind)}:1`;
    }
  }
  return Object.keys(headers).length ? headers : undefined;
}

function sanitizeFailureKind(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64);
}

function formatFailureKinds(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, count]) => typeof count === 'number' && Number.isFinite(count) && count > 0)
    .map(([kind, count]) => [sanitizeFailureKind(kind), Math.trunc(count as number)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? entries.map(([kind, count]) => `${kind}:${count}`).join(',') : null;
}

export function gatewayError(
  request: Request,
  env: Record<string, unknown>,
  route: string,
  status: number,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
  gatewayCode: string | null = null,
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
    return responsesErrorResponse(
      request,
      env,
      status,
      message,
      requestId,
      responsesDiagnosticHeaders(details, extraHeaders),
      gatewayCode,
    );
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

export function buildBudgetExhaustedResponse(request: Request, env: Record<string, unknown>, route: string, requestId: string, requestedModel: string, state: LoopState, exposeUpstreamInfo: boolean): Response {
  const status = 504;
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
    `Gateway failover budget exhausted after ${state.logicalAttempts} attempt(s).`,
    requestId,
    details,
    undefined,
    GATEWAY_ERROR_CODE.FAILOVER_BUDGET_EXHAUSTED,
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
  let gatewayCode: string = GATEWAY_ERROR_CODE.UPSTREAM_EXHAUSTED;
  if (nothingAttempted) {
    status = 429;
    gatewayCode = GATEWAY_ERROR_CODE.NO_DISPATCHABLE_NODE;
    message = 'No eligible node can dispatch this request right now (cooldown, recovery gate, circuit state, or configured admission limit).';
    retryAfterSec = earliestBlockingRetryAfterSec(tiers, reqDescriptor, now, knownModels_);
  } else {
    status = terminalStatus(state.failureKinds) ?? (last?.status === 429 ? 429 : 502);
    message = `All attempted nodes failed for model "${requestedModel}".`;

    if (retryableFamilyExhaustion && familyFailureSetIsRetryable(state.failureKinds)) {
      const originalStatus = status;
      status = 503;
      gatewayCode = GATEWAY_ERROR_CODE.ATTEMPT_BUDGET_EXHAUSTED;
      message = `Transient failures exhausted the compatible-model failover plan for "${requestedModel}". Retry shortly.`;
      retryAfterSec = originalStatus === 429
        ? earliestFamilyBlockingRetryAfterSec(tiers, reqDescriptor, requestedModel, now, knownModels_) ?? 1
        : 1;
      state.logger.info('model-family failover plan exhausted by transient failures', {
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
    gatewayCode,
  );
}

function earliestBlockingRetryAfterSec(tiers: Record<number, RuntimeNode[]>, reqDescriptor: RequestDescriptor, now: number = Date.now(), knownModels?: ReadonlySet<string>): number | undefined {
  let minMs = Infinity;
  for (const t of TIER_ORDER) {
    for (const node of tiers[t] ?? []) {
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
  const nodeCd = getCooldownRemainingMs(node.id, now);
  if (nodeCd > 0) return nodeCd;
  const modelCd = getModelCooldownRemainingMs(node.id, requestedModel, now);
  if (modelCd > 0) return modelCd;
  return Infinity;
}

export function buildClientErrorResponse(request: Request, env: Record<string, unknown>, route: string, requestId: string, requestedModel: string, status: number, errorText: string | Uint8Array, state: LoopState, exposeUpstreamInfo: boolean): Response {
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
    return responsesErrorResponse(
      request,
      env,
      status,
      detail,
      requestId,
      responsesDiagnosticHeaders({
        requested_model: requestedModel,
        attempts: state.logicalAttempts,
        dispatches: state.dispatches,
        hedges: state.hedges,
      }),
    );
  }
  return new Response(JSON.stringify({
    error: {
      message: detail,
      details: { requested_model: requestedModel, attempts: state.logicalAttempts, dispatches: state.dispatches, hedges: state.hedges, ...attemptsDetail },
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

function terminalStatusForKind(kind: string): 429 | 502 | 504 {
  if (kind === FAILURE_KIND.RATE_LIMIT || kind === FAILURE_KIND.RATE_LIMIT_GLOBAL) return 429;
  if (kind === FAILURE_KIND.HEADERS_TIMEOUT || kind === FAILURE_KIND.FIRST_EVENT_TIMEOUT) return 504;
  return 502;
}

// Aggregate by CLIENT-VISIBLE terminal status before selecting the winner.
// Failure kinds that mean the same thing to the client belong to one bucket;
// otherwise rate_limit + rate_limit_global, for example, can lose to one
// unrelated kind merely because they were stored under separate keys.
//
// Tie rule is deliberate and order-independent:
//   504 > 502 > 429
// A timeout tie means the request already spent its waiting window, so do not
// mislabel it as capacity-only 429. A generic upstream failure likewise wins a
// tie over 429 because the request was not purely rate-limited.
export function terminalStatus(failureKinds?: Partial<Record<string, number>>): number | null {
  const counts: Record<429 | 502 | 504, number> = { 429: 0, 502: 0, 504: 0 };
  for (const [kind, rawCount] of Object.entries(failureKinds || {})) {
    const count = typeof rawCount === 'number' && Number.isFinite(rawCount)
      ? Math.max(0, Math.trunc(rawCount))
      : 0;
    if (count === 0) continue;
    counts[terminalStatusForKind(kind)] += count;
  }

  const total = counts[429] + counts[502] + counts[504];
  if (total === 0) return null;

  let bestStatus: 429 | 502 | 504 = 504;
  let bestCount = counts[504];
  for (const status of [502, 429] as const) {
    if (counts[status] > bestCount) {
      bestStatus = status;
      bestCount = counts[status];
    }
  }
  return bestStatus;
}
