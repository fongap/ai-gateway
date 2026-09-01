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
import { getCooldownRemainingMs, getModelCooldownRemainingMs, getNodeState } from '../reliability/node-state.js';
import { tier1BlockingWaitMs, tier1HasDeferredCapacity } from '../reliability/tier1-state.js';
import { supportsRequest, isHardRpmExhausted, tierHasDeferredCapacity } from '../scheduler/scheduler.js';
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
    attempts: state.logicalAttempts,
    dispatches: state.dispatches,
    hedges: state.hedges,
    ...(state.failureKinds && Object.keys(state.failureKinds).length
      ? { failure_kinds: state.failureKinds }
      : {}),
    ...(exposeUpstreamInfo && state.attempts.length ? { attempts_detail: state.attempts } : {}),
  };
  return gatewayError(request, env, route, status,
    `Gateway failover budget exhausted after ${state.logicalAttempts} attempt(s).`, requestId, details);
}

export function buildExhaustedResponse(request, env, route, requestId, requestedModel, state, tiers, exposeUpstreamInfo, reqDescriptor) {
  const last = state.attempts[state.attempts.length - 1];
  const nothingAttempted = state.attempts.length === 0;

  // Distinguish WHY no node was available:
  //   saturated (all candidates busy at concurrency caps or hard-RPM exhausted)
  //     -> 503, so bursty multi-agent clients back off instead of hammering;
  //   cooling / circuit open -> 429 + the smallest remaining cooldown;
  //   real failures -> 502.
  // Retry-After is the EARLIEST moment any node that serves `requestedModel`
  // could accept the request again. Only model-serving nodes are considered
  // (a node cooling for an unrelated model must not inflate the wait), and only
  // currently-blocking nodes contribute; the min across blocking reasons is
  // taken so a concurrency-saturated node (frees in ~1s) is not masked by an
  // unrelated node's long RPM window (e.g. 50s).
  const now = Date.now();
  let status;
  let message;
  let retryAfterSec;
  if (nothingAttempted) {
    if (state.tier1ExhaustionReason === 'deadline_too_small') {
      status = 503;
      message = 'The remaining request deadline is too short for another safe upstream attempt.';
      retryAfterSec = 1;
    } else {
      const deferred = TIER_ORDER.some((t) =>
        t === 1
          ? tier1HasDeferredCapacity(tiers[t], reqDescriptor, state.attempted, now)
          : tierHasDeferredCapacity(tiers[t], reqDescriptor, state.attempted, now));
      if (deferred) {
        status = 503;
        message = 'All eligible nodes are at capacity. Retry shortly.';
      } else {
        status = 429;
        message = 'All eligible nodes are temporarily unavailable (cooldown or circuit open).';
      }
      retryAfterSec = earliestBlockingRetryAfterSec(tiers, reqDescriptor, now);
    }
  } else {
    // Terminal status is driven by the aggregated failure kinds, not by whatever
    // the last attempt happened to be. Otherwise a trailing 429 would mask a
    // dominant upstream failure (and vice versa).
    status = terminalStatus(state.failureKinds) ?? (last?.status === 429 ? 429 : 502);
    message = `All nodes failed for model "${requestedModel}".`;
    if (status === 429) {
      retryAfterSec = earliestBlockingRetryAfterSec(tiers, reqDescriptor, now);
      // A distributed rate-limiter deny (rate_limit_global) leaves no node
      // cooldown — the node was never at fault. When that is what blocked
      // everything, back the client off to the next fixed-window reset instead
      // of omitting Retry-After entirely.
      if (retryAfterSec === undefined && state.failureKinds?.rate_limit_global) {
        retryAfterSec = distributedWindowRetryAfterSec(now);
      }
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
  return gatewayError(request, env, route, status, message, requestId, details,
    retryAfterSec ? { 'retry-after': String(retryAfterSec) } : undefined);
}

// Earliest moment any node that serves the request (protocol + surface +
// model descriptor) could accept the request again, as a Retry-After in
// seconds. A node cooling for an unrelated model, or a healthy idle node,
// never contributes — only nodes that actually serve THIS request AND are
// currently blocking it. The min across blocking reasons is returned so the
// shortest real wait wins.
function earliestBlockingRetryAfterSec(tiers, reqDescriptor, now = Date.now()) {
  let minMs = Infinity;
  for (const t of TIER_ORDER) {
    for (const node of tiers[t] ?? []) {
      if (!supportsRequest(node, reqDescriptor)) continue;
      const wait = blockingWaitMs(node, reqDescriptor.model, now);
      if (wait < minMs) minMs = wait;
    }
  }
  if (!Number.isFinite(minMs)) return undefined;
  return Math.max(1, Math.ceil(minMs / 1000));
}

// Per-node wait until this (node, requestedModel) pair could serve again.
// Returns Infinity when the node is healthy & idle (not blocking). Node-level
// cooldown (429/auth/circuit) wins over the model-scoped cooldown (404). Hard
// RPM exhaustion is bounded by the remaining minute window; concurrency
// saturation has no timer so it estimates ~1s (slots free as in-flight
// requests complete).
function blockingWaitMs(node, requestedModel, now) {
  if (node.tier === 'tier-1') return tier1BlockingWaitMs(node, requestedModel, now);
  const nodeCd = getCooldownRemainingMs(node.id, now);
  if (nodeCd > 0) return nodeCd;
  const modelCd = getModelCooldownRemainingMs(node.id, requestedModel, now);
  if (modelCd > 0) return modelCd;
  if (isHardRpmExhausted(node, now)) return Math.max(1, 60_000 - (now % 60_000));
  const s = getNodeState(node.id);
  if (s.activeRequests >= node.limits.concurrency) return 1_000;
  return Infinity;
}

// Seconds until the next fixed-window (60s) reset of the Cloudflare Rate
// Limiting binding backing the distributed deny. Used as the Retry-After for a
// pure rate_limit_global failure, where no node cooldown exists.
function distributedWindowRetryAfterSec(now = Date.now()) {
  return Math.max(1, Math.ceil((60_000 - (now % 60_000)) / 1000));
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

// Map the aggregated per-attempt failure kinds to a terminal HTTP status.
//   dominant rate_limit / distributed deny -> 429 (retryable)
//   dominant headers/first-event timeout  -> 504 (spent, terminal)
//   otherwise (server/network/auth/model) -> 502
function dominantKind(failureKinds) {
  let best = null;
  let bestN = 0;
  for (const [kind, n] of Object.entries(failureKinds || {})) {
    if (n > bestN) { best = kind; bestN = n; }
  }
  return best;
}

function terminalStatus(failureKinds) {
  const dom = dominantKind(failureKinds);
  if (!dom) return null;
  if (dom === 'rate_limit' || dom === 'rate_limit_global') return 429;
  if (dom === 'headers_timeout' || dom === 'first_event_timeout') return 504;
  return 502;
}
