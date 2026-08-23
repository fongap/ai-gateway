import { getNodeState, isCoolingDown, isCircuitOpen } from '../config/node-state.js';

const TIER_ORDER = ['tier-1', 'tier-2', 'tier-3'];

export function selectNodes(nodes, policy, modelInfo, requestedModel, options = {}) {
  const now = Date.now();
  const modelName = modelInfo?.model || requestedModel;

  const tierOrder = policy.tiers || TIER_ORDER;
  const maxAttempts = Math.min(policy.max_attempts || 3, 5);
  const retryBudget = policy.retry_budget || { 'tier-1': 2, 'tier-2': 1, 'tier-3': 1 };

  const eligible = nodes.filter(n => {
    if (!n.models || Object.keys(n.models).length === 0) return true;
    return Object.prototype.hasOwnProperty.call(n.models, modelName);
  });

  const tiered = {};
  for (const tier of tierOrder) {
    tiered[tier] = eligible.filter(n => n.tier === tier);
  }

  const selected = [];
  const tierAttempts = { 'tier-1': 0, 'tier-2': 0, 'tier-3': 0 };

  for (const tier of tierOrder) {
    const tierMax = Math.min(retryBudget[tier] || 99, maxAttempts - selected.length);
    if (tierMax <= 0) continue;

    let candidates = tiered[tier] || [];
    candidates = candidates
      .map(n => {
        const state = getNodeState(n.id);
        const score = computeNodeScore(n, state, now);
        return { node: n, state, score };
      })
      .filter(item => {
        if (isCoolingDown(item.node.id)) return false;
        if (isCircuitOpen(item.node.id)) return false;
        if (item.state.activeRequests >= (item.node.limits?.concurrency || 2)) return false;
        if (item.state.healthScore < 10) return false;
        return true;
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.node.priority !== b.node.priority) return a.node.priority - b.node.priority;
        if (a.state.avgLatencyMs !== b.state.avgLatencyMs) return (a.state.avgLatencyMs || 0) - (b.state.avgLatencyMs || 0);
        return 0;
      });

    for (const candidate of candidates) {
      if (selected.length >= maxAttempts) break;
      if (tierAttempts[tier] >= tierMax) break;
      selected.push(candidate.node);
      tierAttempts[tier]++;
    }
  }

  return selected.slice(0, maxAttempts);
}

function computeNodeScore(node, state, now) {
  let score = 100;

  score -= (100 - (state.healthScore || 50)) * 0.5;

  score -= state.activeRequests * 5;

  score -= Math.max(0, state.recent429s - 1) * 10;

  score -= Math.max(0, state.recent503s - 1) * 15;

  if (state.avgLatencyMs > 0) {
    if (state.avgLatencyMs > 10000) score -= 20;
    else if (state.avgLatencyMs > 5000) score -= 10;
    else if (state.avgLatencyMs > 2000) score -= 5;
  }

  score += node.priority * 0.3;

  return Math.max(0, score);
}