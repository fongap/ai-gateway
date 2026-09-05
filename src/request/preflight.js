// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Request Preflight — the entry-phase orchestration before any node
// attempt is dispatched.
//
// Responsible for:
//   1. request id + route detection + URL parsing
//   2. content-type + body size + JSON parse
//   3. access-key configuration readiness
//   4. authorization (Bearer / x-api-key, timing-safe, fail closed)
//   5. protocol-specific request validation (OpenAI Chat / Responses,
//      Anthropic Messages / count_tokens)
//   6. requested model extraction
//   7. model authorization (visible == callable, key-scoped)
//   8. gateway config readiness and the (model, protocol, surface)
//      feasibility check (no candidate -> 404)
//   9. per-model policy resolution
//
// Explicitly NOT responsible for (those live downstream):
//   - tier selection
//   - any node attempt / dispatch / hedge
//   - stream / non-stream finalization
//   - cross-protocol fallback orchestration
//   - budget / attempt accounting
//
// The function returns either a terminal `Response` (caller returns
// directly) or a `PreflightResult` that the orchestrator carries into
// the native / fallback tier loops. No state mutation, no scheduler
// call, no Reliability touch, no Transport call.

import { loadGatewayConfig } from '../config/nodes.js';
import { loadModelsConfig } from '../config/models.js';
import { loadPoliciesConfig, getPolicy } from '../config/policies.js';
import { getLimits } from '../config/timeouts.js';
import { gatewayError } from './errors.js';
import { authorize } from './auth.js';
import { loadAccessKeysConfig } from '../config/access-keys.js';
import { collectKnownModels } from '../config/registry.js';
import { authorizeModel } from './model-authz.js';
import { evaluateRouteFeasibility } from './route-feasibility.js';
import { detectRoute, normalizePath, acceptsHtml } from './router.js';
import { dashboardResponse } from '../dashboard/pages.js';
import { corsHeaders, readBodyTextWithLimit, BodyTooLargeError } from '../protocol/http.js';
import { validateOpenAIChatRequest } from '../protocol/openai.js';
import {
  anthropicErrorResponse,
  validateAnthropicMessagesRequest, validateAnthropicCountTokensRequest,
  estimateAnthropicInputTokens,
} from '../protocol/anthropic.js';
import { validateOpenAIResponsesRequest } from '../protocol/responses/index.js';
import { jsonResponse } from './response-helpers.js';
import { admitKeyRequest } from '../ratelimit/key-rpm.js';

// (protocol, surface) keyed by the client route. The same map lives in
// handler.js for now; this is a long-term import path. Until the rest of
// the refactor lands, the preflight result simply forwards the values the
// orchestrator needs and lets handler.js own the source-of-truth
// constant.
const ROUTE_PROTOCOL_SURFACE = Object.freeze({
  openai_chat: { protocol: /** @type {'openai'} */ ('openai'), surface: /** @type {'chat_completions'} */ ('chat_completions') },
  openai_responses: { protocol: /** @type {'openai'} */ ('openai'), surface: /** @type {'responses'} */ ('responses') },
  anthropic_messages: { protocol: /** @type {'anthropic'} */ ('anthropic'), surface: /** @type {'messages'} */ ('messages') },
});

export function getRouteProtocolSurface(route) {
  return ROUTE_PROTOCOL_SURFACE[route];
}

/**
 * @typedef {{
 *   ok: false,
 *   response: Response,
 * }} PreflightTerminal
 *
 * @typedef {{
 *   ok: true,
 *   request: Request,
 *   env: any,
 *   ctx: any,
 *   requestId: string,
 *   requestStartMs: number,
 *   route: string,
 *   requestedModel: string,
 *   clientWantsStream: boolean,
 *   fakeStream: boolean,
 *   bodyJson: any,
 *   limits: any,
 *   exposeUpstreamInfo: boolean,
 *   authResult: any,
 *   requestDescriptor: { model: string, protocol: 'openai' | 'anthropic', surface: 'chat_completions' | 'responses' | 'messages' },
 *   config: any,
 *   tiers: { 1: any[], 2: any[], 3: any[] },
 *   policy: any,
 *   failoverBudgetMs: number,
 *   knownModels: Set<string>,
 *   feasibility: { reachable: boolean, nativeSupported: boolean, fallbackSupported: boolean, fallbacks: { protocol: string, surface: string }[] },
 * }} PreflightOk
 *
 * @typedef {PreflightTerminal | PreflightOk} PreflightResult
 */

/**
 * Run the preflight sequence. Returns a `PreflightResult`.
 *
 *   - On any terminal failure (auth, model authz, config, missing
 *     candidate, count_tokens, etc.) `result.ok === false` and the
 *     caller returns `result.response` directly.
 *   - On success, `result.ok === true` and the caller enters the
 *     native tier loop with the carried `requestDescriptor`, `tiers`,
 *     `policy`, and `bodyJson`.
 *
 * @param {Request} request
 * @param {any} env
 * @param {any} ctx
 * @returns {Promise<PreflightResult>}
 */
export async function preflight(request, env, ctx) {
  const requestId = crypto.randomUUID();
  const requestUrl = new URL(request.url);
  const pathname = normalizePath(requestUrl.pathname);
  const route = detectRoute(request.method, pathname);
  const requestStartMs = Date.now();
  const failoverBudgetMs = getLimits(env).failoverBudgetMs;
  const exposeUpstreamInfo = String(env?.EXPOSE_UPSTREAM_INFO ?? '').trim().toLowerCase() === 'true';

  if (request.method === 'OPTIONS') {
    return { ok: false, response: new Response(null, { status: 204, headers: corsHeaders(request, env) }) };
  }
  if (request.method === 'GET' && pathname === '/' && acceptsHtml(request)) {
    return { ok: false, response: await dashboardResponse(request, env) };
  }

  // ---- Authorization (grouped multi-key or legacy single key, fail closed) ----
  const accessConfig = route !== 'version' ? loadAccessKeysConfig(env) : { keys: [], anyNewKey: false };
  if (accessConfig.keys.length === 0 && route !== 'version') {
    return {
      ok: false,
      response: gatewayError(request, env, route, 500,
        'Gateway misconfigured: no GATEWAY_ACCESS_KEY_<GROUP> (or legacy GATEWAY_ACCESS_KEY) is set.', requestId),
    };
  }
  const authResult = route !== 'version' ? await authorize(request, env) : { authorized: true, mode: 'skip', group: null };
  if (route !== 'version' && !authResult.authorized) {
    return {
      ok: false,
      response: gatewayError(request, env, route, 401, 'Unauthorized: gateway access key is invalid or missing.', requestId),
    };
  }

  // Per-key in-isolate RPM cap. The fingerprint is the credential GROUP
  // label (e.g. "AIR", "PRO", "LEGACY") — never the raw key. A cap of
  // 0 means the limiter is disabled. Diagnostic endpoints (health /
  // metrics / version) are exempt: they carry no upstream cost and
  // are useful for an operator to monitor the cap itself.
  if (route !== 'version' && route !== 'health' && route !== 'metrics') {
    const limits = getLimits(env);
    const fingerprint = authResult.group || (authResult.mode === 'legacy' ? 'LEGACY' : 'ANON');
    const verdict = admitKeyRequest(fingerprint, limits.gatewayKeyRpm);
    if (verdict.ok === false) {
      // Narrow the union to the failure variant. `verdict.ok` is a
      // literal `false` after the `===` check, so the union narrows
      // and `retryAfterSec` becomes available without a cast.
      const denied = /** @type {{ ok: false, retryAfterSec: number }} */ (verdict);
      const headers = {
        'retry-after': String(denied.retryAfterSec),
        ...(corsHeaders(request, env) || {}),
      };
      return {
        ok: false,
        response: new Response(
          JSON.stringify({
            error: {
              message: `Gateway access-key RPM cap exceeded. Retry after ${denied.retryAfterSec}s.`,
              type: 'rate_limit_error',
              code: 'gateway_key_rpm',
              retry_after_seconds: denied.retryAfterSec,
            },
          }),
          { status: 429, headers: { 'content-type': 'application/json', ...headers } },
        ),
      };
    }
  }

  // Authenticated diagnostic endpoints short-circuit here.
  const diag = await import('../observability/diagnostic-endpoints.mjs');
  switch (route) {
    case 'version':
      return { ok: false, response: diag.versionResponse(request, env) };
    case 'health':
      return { ok: false, response: diag.healthResponse(request, env, requestId) };
    case 'metrics':
      return { ok: false, response: diag.metricsResponse(request, env, requestId) };
    case 'models':
      return { ok: false, response: diag.modelsListResponse(request, env, requestId, authResult) };
    case 'openai_chat':
    case 'anthropic_messages':
    case 'anthropic_count_tokens':
    case 'openai_responses':
      break;
    default:
      return { ok: false, response: gatewayError(request, env, route, 404, 'Route not found.', requestId) };
  }

  // ---- Request body ----
  const limits = getLimits(env);
  let bodyJson;
  try {
    const contentType = (request.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      return {
        ok: false,
        response: gatewayError(request, env, route, 415, 'This endpoint requires Content-Type: application/json.', requestId),
      };
    }
    const text = await readBodyTextWithLimit(request, limits.maxBodyBytes);
    bodyJson = JSON.parse(text || '{}');
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return { ok: false, response: gatewayError(request, env, route, 413, error.message, requestId) };
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      response: gatewayError(request, env, route, 400, `Invalid JSON request body: ${errorMessage}`, requestId),
    };
  }

  // ---- Local Anthropic count_tokens ----
  if (route === 'anthropic_count_tokens') {
    const mode = String(env?.ANTHROPIC_COUNT_TOKENS_MODE || 'approximate').toLowerCase();
    if (!['approximate', 'disabled'].includes(mode)) {
      return {
        ok: false,
        response: anthropicErrorResponse(request, env, 500, 'ANTHROPIC_COUNT_TOKENS_MODE must be approximate or disabled.', requestId),
      };
    }
    if (mode === 'disabled') {
      return { ok: false, response: anthropicErrorResponse(request, env, 404, 'Token counting is disabled on this gateway.', requestId) };
    }
    const validationError = validateAnthropicCountTokensRequest(bodyJson);
    if (validationError) {
      return { ok: false, response: anthropicErrorResponse(request, env, 400, validationError, requestId) };
    }
    return {
      ok: false,
      response: jsonResponse(200, { input_tokens: estimateAnthropicInputTokens(bodyJson) }, env, request, { 'x-request-id': requestId }),
    };
  }

  // ---- Protocol-specific request validation ----
  let validationError;
  if (route === 'openai_responses') validationError = validateOpenAIResponsesRequest(bodyJson);
  else if (route === 'anthropic_messages') validationError = validateAnthropicMessagesRequest(bodyJson);
  else validationError = validateOpenAIChatRequest(bodyJson);
  if (validationError) {
    return { ok: false, response: gatewayError(request, env, route, 400, validationError, requestId) };
  }

  const requestedModel = String(bodyJson.model || '');
  const clientWantsStream = bodyJson.stream === true;
  const fakeStream = route === 'openai_chat'
    && String(env?.FAKE_STREAM_PROTECTION ?? '').trim().toLowerCase() === 'true'
    && !clientWantsStream;

  // ---- Model authorization (fail closed, BEFORE the scheduler) ----
  // The Known Model Catalog is the union of every explicit node.models key
  // and every MODELS_CONFIG key. It is the single source of model existence:
  // "*" means every model in this catalog, never an arbitrary string, and an
  // empty catalog grants zero models.
  const gatewayConfigForAuth = loadGatewayConfig(env);
  const knownModels = collectKnownModels(gatewayConfigForAuth.nodes, env);
  const modelAuthz = authorizeModel(requestedModel, knownModels, authResult);
  if (!modelAuthz.allowed) {
    return {
      ok: false,
      response: gatewayError(request, env, route, modelAuthz.status, modelAuthz.status === 403
        ? 'Forbidden: the provided key is not permitted to use this model.'
        : 'Model not found for this key.', requestId,
        { configuration_status: gatewayConfigForAuth.status, known_model_count: knownModels.size, ...(exposeUpstreamInfo ? { diagnostics: gatewayConfigForAuth.diagnostics.slice(0, 5) } : {}) }),
    };
  }

  // ---- Candidate pool ----
  const config = loadGatewayConfig(env);
  if (!config.ready) {
    return {
      ok: false,
      response: gatewayError(request, env, route, 500,
        'Gateway misconfigured: no usable node configuration. Check TIER*_NODES_CONFIG_* and TIER*_NODES_SECRETS_*.',
        requestId,
        { configuration_status: config.status, ...(exposeUpstreamInfo ? { diagnostics: config.diagnostics.slice(0, 5) } : {}) }),
    };
  }
  const tiers = config.tiers;
  /** @type {{ model: string, protocol: 'openai' | 'anthropic', surface: 'chat_completions' | 'responses' | 'messages' }} */
  const requestDescriptor = { model: requestedModel, ...ROUTE_PROTOCOL_SURFACE[route] };
  // "Native First, not Native Only": a request is routable when EITHER a native
  // candidate exists OR at least one explicitly configured, supported
  // cross-protocol fallback has a candidate for the requested model. When
  // neither holds, the request returns 404 and never reaches the tier loop or
  // the fallback chain. This restores the pre-refactor feasibility gate that
  // was lost when the candidate-existence check was extracted into preflight
  // (the old handler.js checked native OR fallback before returning 404).
  const feasibility = evaluateRouteFeasibility({
    route, requestedModel, requestDescriptor, tiers, knownModels, env,
  });
  if (!feasibility.reachable) {
    return {
      ok: false,
      response: gatewayError(request, env, route, 404,
        `No configured route can serve model "${requestedModel}" for client protocol "${requestDescriptor.protocol}" surface "${requestDescriptor.surface}". No native or configured protocol-fallback candidate is available.`, requestId),
    };
  }

  const policy = getPolicy(requestedModel, loadModelsConfig(env), loadPoliciesConfig(env));

  return {
    ok: true,
    request,
    env,
    ctx,
    requestId,
    requestStartMs,
    route,
    requestedModel,
    clientWantsStream,
    fakeStream,
    bodyJson,
    limits,
    exposeUpstreamInfo,
    authResult,
    requestDescriptor,
    config,
    tiers,
    policy,
    failoverBudgetMs,
    knownModels,
    feasibility,
  };
}
