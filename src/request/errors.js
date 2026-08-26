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

import { corsHeaders, shouldNotRetryHeaders, trimDiagnostic } from '../protocol/http.js';
import { anthropicErrorTypeForStatus } from '../protocol/anthropic.js';
import { responsesErrorResponse } from '../protocol/responses/index.js';
import { getCooldownRemainingMs } from '../reliability/node-state.js';
import { supportsModel, isHardRpmExhausted, rpmWindowRetryAfterSec, tierHasDeferredCapacity } from '../scheduler/scheduler.js';
import { TIER_ORDER } from './router.js';

// Unified gateway error: Anthropic-style for Anthropic routes, OpenAI
// Responses-style for /v1/responses, OpenAI Chat-style otherwise.
export function gatewayError(request, env, route, status, message, requestId, details, extraHeaders) {
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

export function buildBudgetExhaustedResponse(request, env, route, requestId, requestedModel, state, exposeUpstreamInfo) {
  // The gateway spent the whole failover budget rotating and still has no answer.
  // Stop: return a clear, terminal error and the attempt COUNT only. Do not keep
  // calling further upstreams, and do not leak the internal failure sequence by
  // default. 504 + x-should-retry:false tells clients not to blind-retry a request
  // the gateway already spent its budget resolving.
  const status = 504;
  const details = {
    requested_model: requestedModel,
    attempts: state.totalAttempts,
    ...(exposeUpstreamInfo && state.attempts.length ? { attempts_detail: state.attempts } : {}),
  };
  return gatewayError(request, env, route, status,
    `Gateway failover budget exhausted after ${state.totalAttempts} attempt(s).`, requestId, details);
}

export function buildExhaustedResponse(request, env, route, requestId, requestedModel, state, tiers, exposeUpstreamInfo) {
  const last = state.attempts[state.attempts.length - 1];
  const nothingAttempted = state.attempts.length === 0;

  // Distinguish WHY no node was available:
  //   saturated (all candidates busy at concurrency caps or hard-RPM exhausted)
  //     -> 503 + Retry-After pointing at the RPM minute boundary when that is
  //     the binding constraint, so bursty multi-agent clients back off instead
  //     of hammering;
  //   cooling / circuit open -> 429 + the smallest remaining cooldown;
  //   real failures -> 502.
  let status;
  let message;
  let retryAfterSec;
  if (nothingAttempted) {
    const deferred = TIER_ORDER.some((t) =>
      tierHasDeferredCapacity(tiers[t], requestedModel, state.attempted));
    if (deferred) {
      status = 503;
      message = 'All eligible nodes are at capacity. Retry shortly.';
      retryAfterSec = rpmBoundRetryAfterSec(tiers, requestedModel, state.attempted);
    } else {
      const remaining = Object.values(tiers).flat()
        .map((n) => getCooldownRemainingMs(n.id))
        .filter((v) => v > 0);
      const minRemaining = remaining.length ? Math.min(...remaining) : 0;
      status = 429;
      message = 'All eligible nodes are temporarily unavailable (cooldown or circuit open).';
      if (minRemaining > 0) retryAfterSec = Math.ceil(minRemaining / 1000);
    }
  } else {
    status = last?.status === 429 ? 429 : 502;
    message = `All nodes failed for model "${requestedModel}".`;
    if (status === 429) {
      const remaining = Object.values(tiers).flat()
        .map((n) => getCooldownRemainingMs(n.id))
        .filter((v) => v > 0);
      if (remaining.length) retryAfterSec = Math.ceil(Math.min(...remaining) / 1000);
    }
  }

  const details = {
    requested_model: requestedModel,
    attempts: state.totalAttempts,
    ...(exposeUpstreamInfo && state.attempts.length ? { attempts_detail: state.attempts } : {}),
  };
  // Route-aware body: Anthropic clients must receive Anthropic-shaped errors.
  return gatewayError(request, env, route, status, message, requestId, details,
    retryAfterSec ? { 'retry-after': String(retryAfterSec) } : undefined);
}

// Seconds to the next RPM minute when hard-RPM exhaustion is among the reasons
// this request could not be served; otherwise the default short backoff.
function rpmBoundRetryAfterSec(tiers, requestedModel, attempted) {
  const rpmBlocked = TIER_ORDER.some((t) => tiers[t].some((n) =>
    !attempted.has(n.id)
    && supportsModel(n, requestedModel)
    && isHardRpmExhausted(n)));
  return rpmBlocked ? rpmWindowRetryAfterSec() : 1;
}

export function buildClientErrorResponse(request, env, route, requestId, requestedModel, status, errorText, state, exposeUpstreamInfo) {
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
      details: { requested_model: requestedModel, attempts: state.totalAttempts, ...attemptsDetail },
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

function extractErrorMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  try {
    const json = JSON.parse(raw);
    return json?.error?.message || json?.message || trimDiagnostic(raw, 300);
  } catch {
    return trimDiagnostic(raw, 300);
  }
}
