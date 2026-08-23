import { getNodeHealthSnapshot, getNodeMetrics } from '../config/node-state.js';

export function buildHealthResponse(nodes, env) {
  const exposeUpstreamInfo = readBooleanEnv(env, 'EXPOSE_UPSTREAM_INFO', false);
  const metrics = getNodeMetrics();
  const now = Date.now();

  const nodeDetails = nodes.map(n => {
    const health = getNodeHealthSnapshot(n.id);
    return {
      id: n.id,
      tier: n.tier,
      provider: exposeUpstreamInfo ? n.provider : n.tier,
      priority: n.priority,
      ...health,
    };
  });

  const cooling = nodeDetails.filter(n => n.status === 'cooling_down').length;
  const totalRequests = nodeDetails.reduce((s, n) => s + n.total_requests, 0);
  const totalSuccesses = nodeDetails.reduce((s, n) => s + n.total_successes, 0);

  return {
    status: nodes.length > 0 ? 'ok' : 'misconfigured',
    version: '5.14.0',
    nodes_total: nodes.length,
    nodes_active: nodes.length - cooling,
    nodes_cooling_down: cooling,
    tiers: {
      free: nodes.filter(n => n.tier === 'free').length,
      paid: nodes.filter(n => n.tier === 'paid').length,
      plus: nodes.filter(n => n.tier === 'plus').length,
    },
    client_stats: {
      started_at: new Date(metrics.startedAt).toISOString(),
      requests_total: metrics.totalRequests,
      successes_total: metrics.totalSuccesses,
      failures_total: metrics.totalFailures,
      cancellations_total: metrics.totalCancellations,
      fallback_activations_total: metrics.fallbackActivations,
      fallback_successes_total: metrics.fallbackSuccesses,
      success_rate: metrics.totalRequests > 0
        ? (metrics.totalSuccesses / metrics.totalRequests * 100).toFixed(1) + '%'
        : 'N/A',
    },
    nodes: nodeDetails,
  };
}

function readBooleanEnv(env, name, fallback = false) {
  const value = env?.[name];
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(normalized);
}