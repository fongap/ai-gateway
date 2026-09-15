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

// Responses keeps its standard body envelope, so compact non-sensitive
// diagnostics travel in headers instead of adding a gateway-specific `details`
// object that Codex/OpenAI clients do not expect. Never expose node ids,
// providers, credentials, upstream messages or the ordered attempt sequence.
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

// Unified gateway error: Anthropic-style for Anthropic routes, OpenAI
// Responses-style for /v1/responses, OpenAI Chat-style otherwise.
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
  // The gateway spent the whole failover budget rotating and still has no answer.
  // Stop: return a clear, terminal error and the attempt COUNT only. Do not keep
  // calling further upstreams, and do not leak the internal failure sequence by
  // default. 504 + x-should-retry:false tells clients not to blind-retry a request
  // the gateway already spent its budget resolving.
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

  // The Known Model Catalog bounds wildcard nodes so the exhausted-response
  // analysis (deferred capacity, blocking wait) only considers nodes that
  // actually serve a known model. Optional: when absent, the analysis degrades
  // to the legacy permissive wildcard behavior. state may carry the same Set
  // that preflight computed.
  const knownModels_ = knownModels ?? state.knownModels;

  // Distinguish WHY no node was available:
  //   cooling / circuit / recovery / explicit local admission -> 429;
  //   real failures -> terminal status unless a bounded model-family attempt
  //     plan failed only for transient reasons, in which case 503 asks the
  //     client to retry the turn instead of stopping for manual intervention.
  const now = Date.now();
  let status: number;
  let message: string;
  let retryAfterSec: number | undefined;
  let gatewayCode = GATEWAY_ERROR_CODE.UPSTREAM_EXHAUSTED;
  if (nothingAttempted) {
    status = 429;
    gatewayCode = GATEWAY_ERROR_CODE.NO_DISPATCHABLE_NODE;
    message = 'No eligible node can dispatch this request right now (cooldown, recovery gate, circuit state, or configured admission limit).';
    retryAfterSec = earliestBlockingRetryAfterSec(tiers, reqDescriptor, now, knownModels_);
  } else {
    // Terminal status is driven by the aggregated failure kinds, not by whatever
    // the last attempt happened to be. Otherwise a trailing 429 would mask a
    // dominant upstream failure (and vice versa).
    status = terminalStatus(state.failureKinds) ?? (last?.status === 429 ? 429 : 502);
    message = `All attempted nodes failed for model "${requestedModel}".`;

    // The model-family plan is bounded by the request's max_attempts. It may
    // stop before every configured account has been tried, so never describe
    // this condition as proof that all compatible capacity is unavailable.
    // If every observed failure is transient, keep the internal reason in
    // failure_kinds and return one retryable 503 so coding clients can resume
    // automatically instead of stopping for a manual "continue".
    if (retryableFamilyExhaustion && familyFailureSetIsRetryable(state.failureKinds)) {
      const originalStatus = status;
      status = 503;
      gatewayCode = GATEWAY_ERROR_CODE.ATTEMPT_BUDGET_EXHAUSTED;
      message = `Transient failures exhausted the compatible-model attempt budget for "${requestedModel}". Retry shortly.`;
      // Rate-limit exhaustion should not be retried every second. Preserve the
      // earliest real cooldown across ALL compatible sibling models when it is
      // available; other transient family failures keep the short retry hint.
      retryAfterSec = originalStatus === 429
        ? earliestFamilyBlockingRetryAfterSec(tiers, reqDescriptor, requestedModel, now, knownModels_) ?? 1
        : 1;
      state.logger.info('model-family attempt budget exhausted by transient failures', {
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
    // attempts = LOGICAL attempts (primary + optional hedge twin each);
    // dispatches = real upstream requests; hedges = hedge twin count.
    attempts: state.logicalAttempts,
    dispatches: state.dispatches,
    hedges: state.hedges,
    ...(state.failureKinds && Object.keys(state.failureKinds).length
      ? { failure_kinds: state.failureKinds }
      : {}),
    ...(exposeUpstreamInfo && state.attempts.length ? { attempts_detail: state.attempts } : {}),
  };
  // Route-aware body: Anthropic clients must receive Anthropic-shaped errors.
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

// Earliest moment any node that serves the request (protocol + surface +
// model descriptor) could accept the request again, as a Retry-After in
// seconds. A node cooling for an unrelated model, or a healthy idle node,
// never contributes — only timed blocking reasons can produce a meaningful
// Retry-After. An explicit max_in_flight ceiling has no known release time and
// therefore intentionally contributes no guessed delay.
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

// Family-aware Retry-After. A Code-Ultra request may have just exhausted
// Code-Ultra + Code-Max + Code-Pro; using only the original alias can over-wait
// or under-wait. Take the earliest real recovery across every configured
// compatible sibling while keeping the underlying per-node cooldown reasons
// untouched for diagnostics and scheduling.
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

// Per-node timed wait until this (node, requestedModel) pair could serve again.
// Returns Infinity when no timed block exists. Node-level cooldown
// (429/auth/circuit) wins over the model-scoped cooldown (404). Live in-flight
// load is ranking-only by default; an explicit max_in_flight limit has no
// deterministic wait and is therefore not represented here.
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
  // The contract says EVERY observed family failure must be transient. Unknown
  // or future failure kinds fail closed here instead of being accidentally
  // hidden behind a retryable 503 just because one sibling also returned 429.
  return observed.every(([kind]) => retryableKinds.has(kind));
}

// Map the aggregated per-attempt failure kinds to a terminal HTTP status.
//   dominant rate_limit / distributed deny -> 429 (retryable)
//   dominant headers/first-event timeout  -> 504 (spent, terminal)
//   otherwise (server/network/auth/model) -> 502
function dominantKind(failureKinds?: Partial<Record<string, number>>): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [kind, n] of Object.entries(failureKinds || {})) {
    if ((n || 0) > bestN) { best = kind; bestN = n || 0; }
  }
  return best;
}

function terminalStatus(failureKinds?: Partial<Record<string, number>>): number | null {
  const dom = dominantKind(failureKinds);
  if (!dom) return null;
  if (dom === FAILURE_KIND.RATE_LIMIT || dom === FAILURE_KIND.RATE_LIMIT_GLOBAL) return 429;
  if (dom === FAILURE_KIND.HEADERS_TIMEOUT || dom === FAILURE_KIND.FIRST_EVENT_TIMEOUT) return 504;
  return 502;
}
