// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio

import { loadGatewayConfig } from '../config/nodes.ts';
import { loadModelsConfig } from '../config/models.ts';
import { loadPoliciesConfig, getPolicy } from '../config/policies.ts';
import { getLimits } from '../config/timeouts.ts';
import { gatewayError } from './errors.ts';
import { authorize } from './auth.ts';
import { loadAccessKeysConfig } from '../config/access-keys.ts';
import { collectKnownModels } from '../config/registry.ts';
import { authorizeModel, filterVisibleModels } from './model-authz.ts';
import { evaluateRouteFeasibility } from './route-feasibility.ts';
import { modelFallbackCandidates } from './model-fallback.ts';
import { detectRoute, normalizePath, acceptsHtml } from './router.ts';
import { dashboardResponse } from '../dashboard/pages.ts';
import { corsHeaders, readBodyTextWithLimit, BodyTooLargeError } from '../protocol/http.ts';
import { validateOpenAIChatRequest } from '../protocol/openai.ts';
import {
  anthropicErrorResponse,
  validateAnthropicMessagesRequest, validateAnthropicCountTokensRequest,
  estimateAnthropicInputTokens,
} from '../protocol/anthropic.ts';
import { validateOpenAIResponsesRequest } from '../protocol/responses/index.ts';
import { jsonResponse } from './response-helpers.ts';
import { admitKeyRequest } from '../ratelimit/key-rpm.ts';
import type { AuthResult, RequestDescriptor, RouteFeasibilityResult } from '../types/request.ts';
import type { GatewayConfig } from '../config/nodes.ts';
import type { PolicyConfig } from '../types/policy.ts';
import type { RuntimeNode } from '../types/node.ts';

const ROUTE_PROTOCOL_SURFACE = Object.freeze({
  openai_chat: { protocol: 'openai', surface: 'chat_completions' },
  openai_responses: { protocol: 'openai', surface: 'responses' },
  anthropic_messages: { protocol: 'anthropic', surface: 'messages' },
} as const);

export function getRouteProtocolSurface(route: keyof typeof ROUTE_PROTOCOL_SURFACE): { protocol: 'openai' | 'anthropic', surface: 'chat_completions' | 'responses' | 'messages' } {
  return ROUTE_PROTOCOL_SURFACE[route];
}

export type PreflightTerminal = { ok: false, response: Response };
export type PreflightOk = {
  ok: true,
  request: Request,
  env: Record<string, unknown>,
  ctx: { waitUntil?: Function },
  requestId: string,
  requestStartMs: number,
  route: string,
  requestedModel: string,
  clientWantsStream: boolean,
  fakeStream: boolean,
  bodyJson: Record<string, unknown>,
  limits: Record<string, number>,
  exposeUpstreamInfo: boolean,
  authResult: AuthResult,
  requestDescriptor: RequestDescriptor,
  config: GatewayConfig,
  tiers: Record<number, RuntimeNode[]>,
  policy: PolicyConfig,
  failoverBudgetMs: number,
  knownModels: Set<string>,
  feasibility: RouteFeasibilityResult,
};
export type PreflightResult = PreflightTerminal | PreflightOk;

export async function preflight(request: Request, env: Record<string, unknown>, ctx: { waitUntil?: Function }): Promise<PreflightResult> {
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

  const accessConfig = loadAccessKeysConfig(env);
  if (accessConfig.keys.length === 0) {
    return {
      ok: false,
      response: gatewayError(request, env, route, 500,
        'Gateway misconfigured: no GATEWAY_ACCESS_KEY_<GROUP> is set.', requestId),
    };
  }
  const authResult: AuthResult = await authorize(request, env);
  if (!authResult.authorized) {
    return {
      ok: false,
      response: gatewayError(request, env, route, 401, 'Unauthorized: gateway access key is invalid or missing.', requestId),
    };
  }

  // Local diagnostics/model-list routes carry no upstream cost and do not
  // consume the client-key RPM budget.
  if (route !== 'health' && route !== 'metrics'
      && route !== 'models' && route !== 'anthropic_count_tokens') {
    const limits = getLimits(env);
    const fingerprint = ('group' in authResult ? authResult.group : null) || 'ANON';
    const verdict = admitKeyRequest(fingerprint, limits.gatewayKeyRpm);
    if (verdict.ok === false) {
      const headers = {
        'retry-after': String(verdict.retryAfterSec),
        ...(corsHeaders(request, env) || {}),
      };
      return {
        ok: false,
        response: new Response(JSON.stringify({
          error: {
            message: `Gateway access-key RPM cap exceeded. Retry after ${verdict.retryAfterSec}s.`,
            type: 'rate_limit_error',
            code: 'gateway_key_rpm',
            retry_after_seconds: verdict.retryAfterSec,
          },
        }), { status: 429, headers: { 'content-type': 'application/json', ...headers } }),
      };
    }
  }

  const diag = await import('../observability/diagnostic-endpoints.ts');
  switch (route) {
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

  const limits = getLimits(env);
  let bodyJson: Record<string, unknown>;
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

  let validationError: string | null | undefined;
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

  const gatewayConfigForAuth = loadGatewayConfig(env);
  const knownModels = collectKnownModels(gatewayConfigForAuth.nodes, env);
  const modelAuthz = authorizeModel(requestedModel, knownModels, authResult);
  if (modelAuthz.allowed === false) {
    const denyStatus = modelAuthz.status;
    return {
      ok: false,
      response: gatewayError(request, env, route, denyStatus, denyStatus === 403
        ? 'Forbidden: the provided key is not permitted to use this model.'
        : 'Model not found for this key.', requestId,
        { configuration_status: gatewayConfigForAuth.status, known_model_count: knownModels.size, ...(exposeUpstreamInfo ? { diagnostics: gatewayConfigForAuth.diagnostics.slice(0, 5) } : {}) }),
    };
  }

  const callableModels = new Set(filterVisibleModels(knownModels, authResult));
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
  const requestDescriptor: RequestDescriptor = {
    route: route as 'openai_chat' | 'openai_responses' | 'anthropic_messages',
    model: requestedModel,
    ...ROUTE_PROTOCOL_SURFACE[route as keyof typeof ROUTE_PROTOCOL_SURFACE],
  };

  const feasibility = evaluateRouteFeasibility({
    route, requestedModel, requestDescriptor, tiers, knownModels: callableModels, env,
  });
  let familyReachable = feasibility.reachable;
  if (!familyReachable) {
    for (const effectiveModel of modelFallbackCandidates(requestedModel, callableModels)) {
      if (effectiveModel === requestedModel) continue;
      const effectiveDescriptor = { ...requestDescriptor, model: effectiveModel };
      const candidateFeasibility = evaluateRouteFeasibility({
        route,
        requestedModel: effectiveModel,
        requestDescriptor: effectiveDescriptor,
        tiers,
        knownModels: callableModels,
        env,
      });
      if (candidateFeasibility.reachable) {
        familyReachable = true;
        break;
      }
    }
  }
  if (!familyReachable) {
    return {
      ok: false,
      response: gatewayError(request, env, route, 404,
        `No configured route can serve model "${requestedModel}" for client protocol "${requestDescriptor.protocol}" surface "${requestDescriptor.surface}", including internal compatible model fallback.`, requestId),
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
    knownModels: callableModels,
    feasibility,
  };
}
