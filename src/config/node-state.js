const HEALTH_SCORE_INITIAL = 50;
const HEALTH_SCORE_MIN = 1;
const HEALTH_SCORE_MAX = 100;
const HEALTH_SCORE_SUCCESS_GAIN = 3;
const HEALTH_SCORE_COOLDOWN_RECOVERY = 10;
const LATENCY_EWMA_ALPHA = 0.3;
const MAX_EXPONENTIAL_BACKOFF_MULTIPLIER = 8;
const MAX_STATE_ENTRIES = 256;
const CLEANUP_INTERVAL_MS = 30_000;

const nodeState = new Map();
const nodeMetrics = {
  startedAt: Date.now(),
  totalRequests: 0,
  totalSuccesses: 0,
  totalFailures: 0,
  totalCancellations: 0,
  fallbackActivations: 0,
  fallbackSuccesses: 0,
};
let lastCleanupTime = 0;

export function getNodeState(nodeId) {
  if (!nodeState.has(nodeId)) {
    nodeState.set(nodeId, {
      healthScore: HEALTH_SCORE_INITIAL,
      activeRequests: 0,
      consecutiveFailures: 0,
      avgLatencyMs: 0,
      cooldownUntil: 0,
      cooldownReason: null,
      circuitState: 'closed',
      circuitFailures: 0,
      circuitHalfOpenAllow: false,
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      recent429s: 0,
      recent503s: 0,
      streamSuccessRate: 1.0,
      lastUsedAt: 0,
    });
  }
  return nodeState.get(nodeId);
}

export function recordRequestStart(nodeId) {
  const s = getNodeState(nodeId);
  s.activeRequests++;
  s.totalRequests++;
  s.lastUsedAt = Date.now();
  nodeMetrics.totalRequests++;
}

export function recordSuccess(nodeId, latencyMs) {
  const s = getNodeState(nodeId);
  s.activeRequests = Math.max(0, s.activeRequests - 1);
  s.healthScore = Math.min(HEALTH_SCORE_MAX, s.healthScore + HEALTH_SCORE_SUCCESS_GAIN);
  s.consecutiveFailures = 0;
  s.totalSuccesses++;
  nodeMetrics.totalSuccesses++;
  if (s.circuitState === 'half-open') {
    s.circuitState = 'closed';
    s.circuitFailures = 0;
    s.circuitHalfOpenAllow = false;
  }
  s.avgLatencyMs = s.avgLatencyMs === 0
    ? latencyMs
    : s.avgLatencyMs * (1 - LATENCY_EWMA_ALPHA) + latencyMs * LATENCY_EWMA_ALPHA;
}

export function recordFailure(nodeId, status, cooldownMs, reason) {
  const s = getNodeState(nodeId);
  s.activeRequests = Math.max(0, s.activeRequests - 1);
  s.totalFailures++;
  nodeMetrics.totalFailures++;
  s.consecutiveFailures++;

  if (status === 429) {
    s.recent429s++;
    s.healthScore = Math.max(HEALTH_SCORE_MIN, s.healthScore - 15);
  } else if (status === 503 || status === 502 || status === 504) {
    s.recent503s++;
    s.healthScore = Math.max(HEALTH_SCORE_MIN, s.healthScore - 20);
  } else if (status === 401 || status === 403) {
    s.healthScore = Math.max(HEALTH_SCORE_MIN, s.healthScore - 50);
  } else if (status === 0) {
    s.healthScore = Math.max(HEALTH_SCORE_MIN, s.healthScore - 12);
  } else {
    s.healthScore = Math.max(HEALTH_SCORE_MIN, s.healthScore - 10);
  }

  if (cooldownMs > 0) {
    s.cooldownUntil = Date.now() + cooldownMs;
    s.cooldownReason = reason || `status:${status}`;
  }
}

export function recordNeutralEnd(nodeId) {
  const s = getNodeState(nodeId);
  s.activeRequests = Math.max(0, s.activeRequests - 1);
}

export function recordCancellation(nodeId) {
  recordNeutralEnd(nodeId);
  nodeMetrics.totalCancellations++;
}

export function isCoolingDown(nodeId) {
  const s = getNodeState(nodeId);
  if (s.cooldownUntil <= 0) return false;
  if (s.cooldownUntil <= Date.now()) {
    s.cooldownUntil = 0;
    s.cooldownReason = null;
    return false;
  }
  return true;
}

export function isCircuitOpen(nodeId) {
  const s = getNodeState(nodeId);
  if (s.circuitState === 'open') {
    if (s.cooldownUntil <= Date.now()) {
      s.circuitState = 'half-open';
      s.circuitHalfOpenAllow = true;
      return false;
    }
    return true;
  }
  return false;
}

export function applyExponentialBackoff(nodeId, status, baseCooldownMs) {
  const s = getNodeState(nodeId);
  if (status === 429 || status === 401 || status === 403) return baseCooldownMs;
  return baseCooldownMs * Math.min(MAX_EXPONENTIAL_BACKOFF_MULTIPLIER, Math.pow(2, Math.max(0, s.consecutiveFailures)));
}

export function getRetryAfterMs(headers) {
  const value = headers.get('Retry-After');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(500, Math.min(seconds * 1000, 60_000));
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(500, Math.min(dateMs - Date.now(), 60_000));
  return 0;
}

export function nextCooldownMs(nodeIds) {
  const now = Date.now();
  const values = nodeIds.map(id => {
    const s = getNodeState(id);
    return s.cooldownUntil > now ? s.cooldownUntil - now : 0;
  }).filter(Boolean);
  return values.length ? Math.min(...values) : 0;
}

export function cleanupStaleState() {
  const now = Date.now();
  for (const [, state] of nodeState) {
    if (state.cooldownUntil > 0 && state.cooldownUntil <= now) {
      state.cooldownUntil = 0;
      state.cooldownReason = null;
      state.consecutiveFailures = 0;
      state.healthScore = Math.min(HEALTH_SCORE_MAX, state.healthScore + HEALTH_SCORE_COOLDOWN_RECOVERY);
    }
  }
  if (nodeState.size > MAX_STATE_ENTRIES) {
    const targetSize = Math.floor(MAX_STATE_ENTRIES * 0.75);
    const entries = [...nodeState.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (let i = 0; i < nodeState.size - targetSize; i++) {
      nodeState.delete(entries[i][0]);
    }
  }
}

export function getNodeMetrics() {
  return nodeMetrics;
}

export function getAllNodeStates() {
  return nodeState;
}

export function getNodeHealthSnapshot(nodeId) {
  const s = getNodeState(nodeId);
  const now = Date.now();
  const cooling = s.cooldownUntil > now;
  return {
    health_score: Math.round(s.healthScore),
    status: cooling ? 'cooling_down' : 'active',
    cooldown_remaining_ms: cooling ? s.cooldownUntil - now : 0,
    cooldown_reason: s.cooldownReason || null,
    active_requests: s.activeRequests,
    circuit_state: s.circuitState,
    avg_latency_ms: Math.round(s.avgLatencyMs) || 0,
    total_requests: s.totalRequests,
    total_successes: s.totalSuccesses,
    total_failures: s.totalFailures,
    consecutive_failures: s.consecutiveFailures,
    recent_429s: s.recent429s,
    recent_503s: s.recent503s,
    last_used_at: s.lastUsedAt > 0 ? new Date(s.lastUsedAt).toISOString() : null,
  };
}

export function checkCleanup() {
  const now = Date.now();
  if (now - lastCleanupTime > CLEANUP_INTERVAL_MS) {
    lastCleanupTime = now;
    cleanupStaleState();
  }
}