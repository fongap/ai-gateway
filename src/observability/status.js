// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Diagnostic endpoints: /health, /metrics, /version, /v1/models.
// Responses contain node ids and runtime state only — never credentials.

import { loadGatewayConfig } from '../config/nodes.js';
import { snapshotNode } from '../reliability/node-state.js';
import { gatewayStats } from './stats.js';
import { corsHeaders, jsonError } from '../protocol/http.js';
import { OPENAI_COMPATIBLE_PROFILE } from '../config/profiles.js';

export const APP_META = Object.freeze({
  name: 'ai-gateway',
  displayName: 'Smart AI Gateway',
  version: '6.1.0',
});

function sanitizePrometheusLabel(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// Logical model list with capability metadata. Model capability is derived from
// the serving node's provider profile (never from model-name guessing), and the
// gateway always exposes all three wire surfaces. Fields beyond the OpenAI
// baseline are additive and backward-compatible.
function buildModelsList(nodes) {
  const models = new Map();
  const touch = (logical, node) => {
    const profile = node.profile || OPENAI_COMPATIBLE_PROFILE;
    let entry = models.get(logical);
    if (!entry) {
      entry = {
        id: logical,
        object: 'model',
        created: 0,
        owned_by: APP_META.name,
        apiBackend: profile.id,
        reasonings: [],
        caps: { tools: false, reasoning: false, vision: false, stream: false },
      };
      models.set(logical, entry);
    }
    if (entry.apiBackend === profile.id) entry.apiBackend = profile.id;
    for (const e of profile.reasoning_efforts) {
      if (!entry.reasonings.includes(e)) entry.reasonings.push(e);
    }
    entry.caps.tools = entry.caps.tools || profile.capabilities.tools;
    entry.caps.reasoning = entry.caps.reasoning || profile.capabilities.reasoning;
    entry.caps.vision = entry.caps.vision || profile.capabilities.vision;
    entry.caps.stream = entry.caps.stream || profile.capabilities.stream;
  };
  for (const node of nodes) {
    const keys = Object.keys(node.models || {});
    for (const logical of keys) touch(logical, node);
  }
  const data = [...models.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => ({
      id: entry.id,
      object: 'model',
      created: 0,
      owned_by: APP_META.name,
      apiBackend: entry.apiBackend,
      protocols: ['chat_completions', 'responses', 'messages'],
      supports_tools: entry.caps.tools,
      supports_reasoning: entry.caps.reasoning,
      supports_reasoning_effort: entry.caps.reasoning,
      reasoning_efforts: entry.reasonings.sort(),
      supports_vision: entry.caps.vision,
      supports_stream: entry.caps.stream,
    }));
  return { object: 'list', data };
}

export function healthResponse(request, env, requestId) {
  const config = loadGatewayConfig(env);
  const now = Date.now();
  const endpoints = config.nodes.map((n) => ({
    id: n.id,
    tier: n.tier,
    provider: n.provider,
    priority: n.priority,
    models: Object.keys(n.models || {}),
    ...snapshotNode(n.id, now),
  }));
  const cooling = endpoints.filter((e) => e.status === 'cooling_down').length;
  return new Response(JSON.stringify({
    status: config.status,
    nodes_total: config.nodes.length,
    nodes_active: config.nodes.length - cooling,
    nodes_cooling_down: cooling,
    tiers: {
      'tier-1': config.nodes.filter((n) => n.tier === 'tier-1').length,
      'tier-2': config.nodes.filter((n) => n.tier === 'tier-2').length,
      'tier-3': config.nodes.filter((n) => n.tier === 'tier-3').length,
    },
    note: "Isolate-local best-effort state; not a cluster-wide snapshot.",
    client_stats: {
      started_at: new Date(gatewayStats.startedAt).toISOString(),
      requests_total: gatewayStats.requests,
      successes_total: gatewayStats.successes,
      failures_total: gatewayStats.failures,
      active_requests: gatewayStats.activeRequests,
      cancellations_total: gatewayStats.cancellations,
    },
    diagnostics: config.diagnostics,
    endpoints,
    request_id: requestId,
  }, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
      ...corsHeaders(request, env),
    },
  });
}

export function metricsResponse(request, env) {
  const config = loadGatewayConfig(env);
  const now = Date.now();
  const lines = [];
  const emit = (name, type, help) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
  };
  const counter = (name, value, labels = '') => lines.push(`${name}{${labels}} ${value}`);

  emit('gateway_client_requests_total', 'counter', 'Counted client API requests since isolate start.');
  counter('gateway_client_requests_total', gatewayStats.requests);
  emit('gateway_client_successes_total', 'counter', 'Successful client API responses (HTTP < 400).');
  counter('gateway_client_successes_total', gatewayStats.successes);
  emit('gateway_client_failures_total', 'counter', 'Failed client API responses (HTTP >= 400 or stream error).');
  counter('gateway_client_failures_total', gatewayStats.failures);
  emit('gateway_client_active_requests', 'gauge', 'Client requests currently active in this isolate.');
  counter('gateway_client_active_requests', gatewayStats.activeRequests);

  emit('gateway_node_health_score', 'gauge', 'Node health score (1-100).');
  emit('gateway_node_circuit_state', 'gauge', 'Circuit state per node (0 closed, 1 half-open, 2 open).');
  emit('gateway_node_active_requests', 'gauge', 'In-flight upstream requests per node.');
  emit('gateway_node_cooldown_remaining_ms', 'gauge', 'Remaining node-local cooldown in ms.');
  emit('gateway_node_avg_latency_ms', 'gauge', 'EWMA of response-header latency in ms.');
  emit('gateway_node_requests_total', 'counter', 'Total upstream attempts per node.');
  emit('gateway_node_successes_total', 'counter', 'Total successful upstream attempts per node.');
  emit('gateway_node_failures_total', 'counter', 'Total failed upstream attempts per node.');

  for (const node of config.nodes) {
    const s = snapshotNode(node.id, now);
    const label = `node_id="${sanitizePrometheusLabel(node.id)}",tier="${node.tier}",provider="${sanitizePrometheusLabel(node.provider)}"`;
    counter('gateway_node_health_score', s.health_score, label);
    counter('gateway_node_circuit_state', ({ closed: 0, 'half-open': 1, open: 2 })[s.circuit_state] ?? 0, `node_id="${sanitizePrometheusLabel(node.id)}"`);
    counter('gateway_node_active_requests', s.active_requests, label);
    counter('gateway_node_cooldown_remaining_ms', s.cooldown_remaining_ms, label);
    counter('gateway_node_avg_latency_ms', s.avg_latency_ms, label);
    counter('gateway_node_requests_total', s.total_requests, label);
    counter('gateway_node_successes_total', s.total_successes, label);
    counter('gateway_node_failures_total', s.total_failures, label);
  }

  return new Response(lines.join('\n') + '\n', {
    status: 200,
    headers: {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(request, env),
    },
  });
}

export function versionResponse(request, env) {
  const repositoryRaw = String(env?.PROJECT_REPOSITORY_URL || '').trim();
  let repository;
  try {
    const url = new URL(repositoryRaw);
    repository = url.protocol === 'https:' ? url.href.replace(/\/$/, '') : undefined;
  } catch { repository = undefined; }
  const config = loadGatewayConfig(env);
  return new Response(JSON.stringify({
    name: APP_META.name,
    display_name: APP_META.displayName,
    version: APP_META.version,
    runtime: 'Cloudflare Workers',
    protocols: ['OpenAI Chat Completions', 'OpenAI Responses', 'Anthropic Messages'],
    ...(repository ? { repository } : {}),
    configuration: {
      status: config.status,
      ready: config.ready,
      nodes_total: config.nodesTotal,
      nodes_usable: config.nodesUsable,
    },
  }, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      ...corsHeaders(request, env),
    },
  });
}

export function modelsListResponse(request, env, requestId) {
  const config = loadGatewayConfig(env);
  return new Response(JSON.stringify(buildModelsList(config.nodes)), {
    status: 200,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
      ...corsHeaders(request, env),
    },
  });
}

export function sanitizedInternalError(request, env, isAnthropic, requestId) {
  const message = 'Internal gateway error.';
  return isAnthropic
    ? anthropicErrorResponseSafe(request, env, message, requestId)
    : jsonError(request, env, 500, message, undefined, requestId);
}

function anthropicErrorResponseSafe(request, env, message, requestId) {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }), {
    status: 500,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'request-id': requestId || '',
      'x-request-id': requestId || '',
      ...corsHeaders(request, env),
    },
  });
}
