// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Diagnostic HTTP endpoints: /health, /metrics, /version, /v1/models.
// Responses contain node ids and runtime state only — never credentials.

import { loadGatewayConfig } from '../config/nodes.js';
import { snapshotNode } from '../reliability/node-state.js';
import { snapshotTier1AccountRuntime } from '../reliability/tier1-state.js';
import { snapshotTier1Affinity } from '../scheduler/tier1-affinity.js';
import { gatewayStats, streamStats } from './gateway-stats.mjs';
import { tokenStats, summarizeTokenStats, tokenMetricSeries } from './token-usage.mjs';
import { corsHeaders, jsonError } from '../protocol/http.js';
import { loadModelRegistry, modelRegistryEntry, servesModel } from '../config/registry.js';

export const APP_META = Object.freeze({
  name: 'ai-gateway',
  displayName: 'Smart AI Gateway',
  version: '1.2.4',
});

function sanitizePrometheusLabel(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// Logical model list with capability metadata. The Model Registry is the primary
// source of the logical-model set AND its capabilities; node `provider` labels
// are only ever used as a backend *label*, never as the model-capability truth.
// The gateway natively speaks OpenAI (chat_completions / responses) and
// Anthropic (messages); the `protocols` field lists the surfaces actually
// offered by the nodes serving each model. Fields beyond the OpenAI baseline
// are additive and backward-compatible.
function buildModelsList(nodes, env) {
  const registry = loadModelRegistry(env);
  const models = new Map();

  // The set of logical models = registry (primary) ∪ node mappings. Because a
  // wildcard node can serve any registry model, but a registry model with no
  // serving node is meaningless to a client, we list only models with ≥1
  // serving node.
  const logicalNames = new Set(Object.keys(registry));
  for (const node of nodes) for (const key of Object.keys(node.models || {})) logicalNames.add(key);

  const entryFor = (logical) => {
    const reg = modelRegistryEntry(env, logical);
    let e = models.get(logical);
    if (!e) {
      e = {
        id: logical,
        object: 'model',
        created: 0,
        owned_by: APP_META.name,
        apiBackends: new Set(),
        surfaces: new Set(),
        reg,
      };
      models.set(logical, e);
    }
    return e;
  };

  for (const node of nodes) {
    // A wildcard node's models map is empty; it still serves every registry
    // model. Otherwise it serves exactly the keys it declares.
    const keys = Object.keys(node.models || {});
    const servedKeys = keys.length === 0 ? [...logicalNames] : keys.filter((k) => logicalNames.has(k));
    for (const logical of servedKeys) {
      if (!servesModel(node, logical)) continue;
      const e = entryFor(logical);
      e.apiBackends.add(node.provider);
      for (const surface of node.surfaces || []) e.surfaces.add(surface);
    }
  }

  const data = [...models.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((e) => e.apiBackends.size > 0)
    .map((e) => {
      const backends = [...e.apiBackends];
      const apiBackend = backends.length === 1 ? backends[0] : 'mixed';
      return {
        id: e.id,
        object: 'model',
        created: 0,
        owned_by: APP_META.name,
        apiBackend,
        api_backends: backends,
        protocols: [...e.surfaces].sort(),
        supports_tools: e.reg.capabilities.tools,
        supports_reasoning: e.reg.capabilities.reasoning,
        supports_reasoning_effort: e.reg.capabilities.reasoning,
        reasoning_efforts: [...e.reg.reasoning_efforts].sort(),
        supports_vision: e.reg.capabilities.vision,
        supports_stream: e.reg.capabilities.stream,
      };
    });
  return { object: 'list', data };
}

export function healthResponse(request, env, requestId) {
  const config = loadGatewayConfig(env);
  const now = Date.now();
  const registryModels = Object.keys(loadModelRegistry(env));
  const endpoints = config.nodes.map((n) => {
    const configuredModels = Object.keys(n.models || {});
    const models = configuredModels.length ? configuredModels : registryModels;
    const base = {
      id: n.id, tier: n.tier, provider: n.provider, protocol: n.protocol,
      surfaces: n.surfaces, priority: n.priority, models: configuredModels,
    };
    if (n.tier !== 'tier-1') return { ...base, ...snapshotNode(n.id, now) };
    const runtime = snapshotTier1AccountRuntime(n.id, models, now);
    const totals = snapshotNode(n.id, now);
    return {
      ...base,
      status: runtime.state,
      active_requests: runtime.in_flight,
      total_requests: totals.total_requests,
      total_successes: totals.total_successes,
      total_failures: totals.total_failures,
      scheduler: 'eligibility_affinity_p2c_passive_ttft',
      runtime,
    };
  });
  const cooling = endpoints.filter((e) => e.status === 'cooldown' || e.status === 'cooling_down').length;
  const disabled = endpoints.filter((e) => e.status === 'disabled').length;
  const observedHealthy = endpoints.filter((e) => e.status === 'observed_healthy' || e.status === 'active').length;
  const unknown = endpoints.filter((e) => e.status === 'configured' || e.status === 'unknown').length;
  // A fully invalid or unconfigured gateway is not "healthy": fail with 503 so
  // probe clients stop polling, while degraded/ready (some usable node) stay 200.
  const statusCode = config.status === 'invalid' || config.status === 'unconfigured' ? 503 : 200;
  return new Response(JSON.stringify({
    status: config.status,
    ready: config.ready,
    nodes_total: config.nodesTotal,
    nodes_usable: config.nodesUsable,
    nodes_active: config.nodesUsable - cooling - disabled,
    nodes_observed_healthy: observedHealthy,
    nodes_unknown_or_configured: unknown,
    nodes_cooling_down: cooling,
    nodes_disabled: disabled,
    tiers: {
      'tier-1': config.nodes.filter((n) => n.tier === 'tier-1').length,
      'tier-2': config.nodes.filter((n) => n.tier === 'tier-2').length,
      'tier-3': config.nodes.filter((n) => n.tier === 'tier-3').length,
    },
    note: "Isolate-local best-effort state; not a cluster-wide snapshot.",
    tier1_affinity: snapshotTier1Affinity(env),
    client_stats: {
      started_at: new Date(gatewayStats.startedAt).toISOString(),
      requests_total: gatewayStats.requests,
      successes_total: gatewayStats.successes,
      failures_total: gatewayStats.failures,
      active_requests: gatewayStats.activeRequests,
      cancellations_total: gatewayStats.cancellations,
    },
    token_stats: (() => {
      const s = summarizeTokenStats();
      return {
        started_at: new Date(s.startedAt).toISOString(),
        totals: {
          input_tokens: s.totals.input,
          output_tokens: s.totals.output,
          total_tokens: s.totals.total,
          usage_reports: s.totals.reports,
          usage_missing: s.totals.missing,
        },
        usage_coverage: s.usageCoverage,
        note: 'Isolate-local, best-effort, upstream-reported usage only; missing usage is never estimated. Not billing-grade.',
      };
    })(),
    diagnostics: config.diagnostics,
    endpoints,
    request_id: requestId,
  }, null, 2), {
    status: statusCode,
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

  emit('gateway_stream_started_total', 'counter', 'Streams relayed to clients from any node (wrapper creation).');
  counter('gateway_stream_started_total', streamStats.started);
  emit('gateway_stream_completed_total', 'counter', 'Streams that reached their completion marker.');
  counter('gateway_stream_completed_total', streamStats.completed);
  emit('gateway_stream_interrupted_total', 'counter', 'Streams interrupted after real output. Equals the sum of the three reason counters below.');
  counter('gateway_stream_interrupted_total', streamStats.interrupted);
  emit('gateway_stream_missing_completion_marker_total', 'counter', 'Interrupted: clean EOF without the completion marker.');
  counter('gateway_stream_missing_completion_marker_total', streamStats.missingCompletion);
  emit('gateway_stream_idle_timeout_total', 'counter', 'Interrupted: STREAM_IDLE_TIMEOUT_MS elapsed without a new chunk.');
  counter('gateway_stream_idle_timeout_total', streamStats.idleTimeout);
  emit('gateway_stream_reader_error_total', 'counter', 'Interrupted: upstream reader threw mid-stream.');
  counter('gateway_stream_reader_error_total', streamStats.readerError);

  // Token usage observability (isolate-local, NOT billing-grade). The
  // unlabelled gateway totals are emitted FIRST: Prometheus text format keeps
  // every line of the same name, and the /metrics delta helpers in the test
  // suite read the first line, so labelled per-bucket series must not precede
  // the totals.
  emit('gateway_tokens_input_total', 'counter', 'Upstream-reported input tokens since isolate start (isolate-local, not billing-grade).');
  counter('gateway_tokens_input_total', tokenStats.totals.input);
  emit('gateway_tokens_output_total', 'counter', 'Upstream-reported output tokens since isolate start (isolate-local, not billing-grade).');
  counter('gateway_tokens_output_total', tokenStats.totals.output);
  emit('gateway_tokens_total', 'counter', 'Upstream-reported total tokens since isolate start (isolate-local, not billing-grade).');
  counter('gateway_tokens_total', tokenStats.totals.total);
  emit('gateway_token_usage_reports_total', 'counter', 'Responses whose upstream reported usable usage.');
  counter('gateway_token_usage_reports_total', tokenStats.totals.reports);
  emit('gateway_token_usage_missing_total', 'counter', 'Delivered responses whose upstream reported NO usable usage (never estimated).');
  counter('gateway_token_usage_missing_total', tokenStats.totals.missing);
  for (const b of tokenMetricSeries()) {
    const label = `model="${sanitizePrometheusLabel(b.model)}",tier="${sanitizePrometheusLabel(b.tier)}",provider="${sanitizePrometheusLabel(b.provider)}",node_id="${sanitizePrometheusLabel(b.nodeId)}"`;
    counter('gateway_tokens_total', b.total, label);
    counter('gateway_tokens_input_total', b.input, label);
    counter('gateway_tokens_output_total', b.output, label);
    counter('gateway_token_usage_reports_total', b.reports, label);
    counter('gateway_token_usage_missing_total', b.missing, label);
  }

  emit('gateway_node_health_score', 'gauge', 'Node health score (1-100).');
  emit('gateway_node_circuit_state', 'gauge', 'Circuit state per node (0 closed, 1 half-open, 2 open).');
  emit('gateway_node_active_requests', 'gauge', 'In-flight upstream requests per node.');
  emit('gateway_node_cooldown_remaining_ms', 'gauge', 'Remaining node-local cooldown in ms.');
  emit('gateway_node_avg_latency_ms', 'gauge', 'EWMA of response-header latency in ms.');
  emit('gateway_node_requests_total', 'counter', 'Total upstream attempts per node.');
  emit('gateway_node_successes_total', 'counter', 'Total successful upstream attempts per node.');
  emit('gateway_node_failures_total', 'counter', 'Total failed upstream attempts per node.');
  emit('gateway_tier1_model_ttft_ewma_ms', 'gauge', 'Passive real-request TTFT EWMA for known Tier 1 account/model pairs. Unknown pairs have no series.');
  emit('gateway_tier1_model_ttft_samples', 'gauge', 'Number of passive real-request TTFT samples for each Tier 1 account/model pair.');
  emit('gateway_tier1_model_cooldown_remaining_ms', 'gauge', 'Remaining Tier 1 account/model cooldown in ms.');

  for (const node of config.nodes) {
    const s = snapshotNode(node.id, now);
    const label = `node_id="${sanitizePrometheusLabel(node.id)}",tier="${node.tier}",provider="${sanitizePrometheusLabel(node.provider)}"`;
    if (node.tier === 'tier-1') {
      const configured = Object.keys(node.models || {});
      const modelIds = configured.length ? configured : Object.keys(loadModelRegistry(env));
      const runtime = snapshotTier1AccountRuntime(node.id, modelIds, now);
      counter('gateway_node_active_requests', runtime.in_flight, label);
      counter('gateway_node_cooldown_remaining_ms', runtime.account_cooldown_remaining_ms, label);
      for (const model of runtime.models) {
        const modelLabel = `${label},model="${sanitizePrometheusLabel(model.model)}"`;
        if (model.ttft_ewma_ms != null) counter('gateway_tier1_model_ttft_ewma_ms', model.ttft_ewma_ms, modelLabel);
        counter('gateway_tier1_model_ttft_samples', model.sample_count, modelLabel);
        counter('gateway_tier1_model_cooldown_remaining_ms', model.cooldown_remaining_ms, modelLabel);
      }
    } else {
      counter('gateway_node_health_score', s.health_score, label);
      counter('gateway_node_circuit_state', ({ closed: 0, 'half-open': 1, open: 2 })[s.circuit_state] ?? 0, `node_id="${sanitizePrometheusLabel(node.id)}"`);
      counter('gateway_node_active_requests', s.active_requests, label);
      counter('gateway_node_cooldown_remaining_ms', s.cooldown_remaining_ms, label);
      counter('gateway_node_avg_latency_ms', s.avg_latency_ms, label);
    }
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
  // Public endpoint: expose only branding/version. Never leak configuration
  // status, node counts, or topology here — that belongs to the auth-protected
  // /health (and server logs).
  return new Response(JSON.stringify({
    name: APP_META.name,
    display_name: APP_META.displayName,
    version: APP_META.version,
    runtime: 'Cloudflare Workers',
    protocols: ['OpenAI Chat Completions', 'OpenAI Responses', 'Anthropic Messages'],
    ...(repository ? { repository } : {}),
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
  return new Response(JSON.stringify(buildModelsList(config.nodes, env)), {
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
