// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Isolate-local runtime state for nodes: health, latency EWMA, concurrency
// slots, cooldowns, and the circuit breaker. This is the ONLY module that
// mutates node runtime state; scheduler and request handler go through it.
//
// Circuit breaker (consecutive-failure state machine):
//   CLOSED --(N consecutive counted failures)--> OPEN --(open period over)->
//   HALF_OPEN (single probe) --success--> CLOSED / --failure--> OPEN
//
// Only transient upstream failures count toward the circuit: 5xx, network
// errors, timeouts, first-event failures. 429 and 401/403 have their own
// node-local cooldowns and never open the circuit. Any success resets the
// consecutive-failure counter.

export const CIRCUIT_FAILURE_THRESHOLD = 3;
export const CIRCUIT_OPEN_MS = 30_000;

const HEALTH_INITIAL = 50;
const HEALTH_MIN = 1;
const HEALTH_MAX = 100;
const HEALTH_SUCCESS_GAIN = 3;
const HEALTH_COOLDOWN_RECOVERY = 10;
const LATENCY_EWMA_ALPHA = 0.3;
const MAX_STATE_ENTRIES = 256;
const CLEANUP_INTERVAL_MS = 30_000;
const STALE_FAILURE_MS = 300_000; // consecutive failures older than 5 min idle no longer chain
const MODEL_MISSING_COOLDOWN_MS = 5_000; // (node,model) cooldown for a 404 mapping mismatch

// Per-node per-minute request counters (current UTC minute bucket only).
// Feeds limits.rpm shaping: in hard mode (the default when rpm is configured)
// an exhausted node is not dispatched this minute; in soft mode it remains a
// last-resort fallback. The counter is isolate-local and never a global quota.
const rpmBuckets = new Map(); // nodeId -> { minute, count }

function currentMinute(now) {
  return Math.floor(now / 60_000);
}

export function noteRpmRequest(nodeId, now) {
  const minute = currentMinute(now);
  const bucket = rpmBuckets.get(nodeId);
  if (!bucket || bucket.minute !== minute) {
    rpmBuckets.set(nodeId, { minute, count: 1 });
    return;
  }
  bucket.count++;
}

// Requests already issued by this node within the current minute.
export function rpmUsage(nodeId, now) {
  const bucket = rpmBuckets.get(nodeId);
  if (!bucket || bucket.minute !== currentMinute(now)) return 0;
  return bucket.count;
}

// Roll back a per-minute RPM reservation when an attempt NEVER reached an
// upstream (distributed rate limiter denied, invalid base URL, etc.). Called
// alongside recordNeutralEnd in those pre-dispatch paths so the isolate-local
// RPM counter does not charge a node for traffic it never sent. Post-dispatch
// neutral ends (client abort mid-stream, 200-with-non-json-body) must NOT call
// this: the upstream was contacted and the RPM charge is legitimate.
// If the minute window has rolled over since the reservation was made, the old
// bucket is already gone (or will be pruned) and there is nothing to roll back
// in the current window — the reservation aged out naturally.
export function rollbackRpmBucket(nodeId, now = Date.now()) {
  const bucket = rpmBuckets.get(nodeId);
  if (bucket && bucket.minute === currentMinute(now)) {
    bucket.count = Math.max(0, bucket.count - 1);
  }
}

const nodeState = new Map();
let lastCleanup = 0;

function createState() {
  return {
    activeRequests: 0,
    healthScore: HEALTH_INITIAL,
    avgLatencyMs: 0,
    cooldownUntil: 0,
    cooldownReason: null,
    circuitState: 'closed',
    consecutiveFailures: 0,
    probeInFlight: false,
    totalRequests: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    lastUsedAt: 0,
    // Per-logical-model cooldown map: a 404 "model not found" cools only the
    // (node, model) pair, NOT the whole node. Other models on the same node
    // stay fully schedulable. Node-level cooldownUntil above is for real node
    // health issues (429/auth/server/circuit); model_missing never touches it.
    modelCooldowns: new Map(),
  };
}

export function getNodeState(nodeId) {
  let s = nodeState.get(nodeId);
  if (!s) {
    s = createState();
    nodeState.set(nodeId, s);
  }
  return s;
}

// ---- Availability ----------------------------------------------------------

// Pure check used by candidate scoring; does not mutate anything.
// Returns 'yes', 'probe' (circuit ready for its single half-open probe), or 'no'.
export function peekAvailability(nodeId, now = Date.now()) {
  const s = getNodeState(nodeId);
  if (s.cooldownUntil > now) return 'no';
  if (s.circuitState === 'closed') return 'yes';
  if (s.circuitState === 'open') return s.cooldownUntil <= now ? 'probe' : 'no';
  // half-open: available only when no probe is in flight
  return s.probeInFlight ? 'no' : 'probe';
}

// Commit a selection: claims a concurrency slot. When the node was ready to
// be probed, this request becomes THE single half-open probe.
// Must only be called after peekAvailability returned 'yes'|'probe'.
export function acquireSlot(nodeId, now = Date.now()) {
  const s = getNodeState(nodeId);
  if (peekAvailability(nodeId, now) === 'no') return false;
  if (s.circuitState === 'open' && s.cooldownUntil <= now) {
    s.circuitState = 'half-open';
    s.probeInFlight = true;
  } else if (s.circuitState === 'half-open' && !s.probeInFlight) {
    s.probeInFlight = true;
  }
  s.activeRequests++;
  s.totalRequests++;
  s.lastUsedAt = now;
  noteRpmRequest(nodeId, now);
  maybeCleanup(now);
  return true;
}

// ---- Outcomes --------------------------------------------------------------

export function recordSuccess(nodeId, latencyMs, now = Date.now()) {
  const s = releaseAndReturn(nodeId);
  s.totalSuccesses++;
  s.healthScore = Math.min(HEALTH_MAX, s.healthScore + HEALTH_SUCCESS_GAIN);
  s.consecutiveFailures = 0;
  s.avgLatencyMs = s.avgLatencyMs === 0 || typeof latencyMs !== 'number'
    ? Math.max(0, latencyMs || 0)
    : s.avgLatencyMs * (1 - LATENCY_EWMA_ALPHA) + latencyMs * LATENCY_EWMA_ALPHA;
  // Any successful upstream response proves the node is alive, so it always
  // closes a half-open probe and never leaves a probe in flight.
  recoverFromHalfOpen(s);
}

// Record a failure. `counted` marks transient upstream failures (5xx /
// network / timeout / first-event) that drive the circuit. `cooldownMs` and
// `reason` set the node-local cooldown window.
export function recordFailure(nodeId, { counted = false, cooldownMs = 0, reason = null } = {}, now = Date.now()) {
  const s = releaseAndReturn(nodeId);
  s.totalFailures++;
  if (cooldownMs > 0) {
    s.cooldownUntil = now + cooldownMs;
    s.cooldownReason = reason;
  }
  s.consecutiveFailures = counted ? s.consecutiveFailures + 1 : 0;

  if (!counted) {
    // Non-counted outcomes (429 / 401 / 403 / 404 / client 4xx). These never
    // open the circuit. If one concludes a half-open probe, the node proved it
    // was reachable (it gave an HTTP answer, even a reject), so it must leave
    // half-open and become schedulable again once any node-local cooldown
    // expires. NEVER leave probeInFlight stuck true.
    recoverFromHalfOpen(s);
    return;
  }

  if (s.circuitState === 'half-open') {
    // Probe failed: reopen and restart the cooldown period.
    openCircuit(s, now);
    return;
  }
  if (s.circuitState === 'closed' && s.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    openCircuit(s, now);
  }
}

export function recordNeutralEnd(nodeId) {
  const s = releaseAndReturn(nodeId);
  // A neutral end (client abort / no-charge) during a half-open probe must not
  // punish the node nor leave it stuck half-open forever.
  recoverFromHalfOpen(s);
}

// Record a model_missing (404) outcome. The node answered, so a half-open probe
// resolves the same way a 429/401 would (recover, become schedulable), but the
// cooldown is applied to the (node, model) PAIR only — the node stays healthy
// for every other model it serves. model_missing never counts toward the
// circuit (a mapping mismatch is not a transient outage) and never penalizes
// node health (it says nothing about the node's ability to serve other models).
export function recordModelMissing(nodeId, model, cooldownMs = MODEL_MISSING_COOLDOWN_MS, now = Date.now()) {
  const s = releaseAndReturn(nodeId);
  if (cooldownMs > 0) {
    s.modelCooldowns.set(model, now + cooldownMs);
  }
  recoverFromHalfOpen(s);
}

// True when this (node, model) pair is in a model_missing cooldown. Used by
// the scheduler to skip the pair without disabling the whole node.
export function isModelCooling(nodeId, model, now = Date.now()) {
  const s = nodeState.get(nodeId);
  if (!s?.modelCooldowns?.size) return false;
  const until = s.modelCooldowns.get(model);
  return until ? until > now : false;
}

export function getModelCooldownRemainingMs(nodeId, model, now = Date.now()) {
  const s = nodeState.get(nodeId);
  if (!s?.modelCooldowns?.size) return 0;
  const until = s.modelCooldowns.get(model);
  return until && until > now ? until - now : 0;
}

function releaseAndReturn(nodeId) {
  const s = getNodeState(nodeId);
  s.activeRequests = Math.max(0, s.activeRequests - 1);
  return s;
}

function openCircuit(s, now) {
  s.circuitState = 'open';
  s.probeInFlight = false;
  s.cooldownUntil = now + CIRCUIT_OPEN_MS;
  s.cooldownReason = `circuit_open_after_${CIRCUIT_FAILURE_THRESHOLD}_failures`;
}

// Central half-open probe resolution. A probe that ends in anything other than
// a *counted* transient failure has proved the node is reachable (success, 429,
// 401/403, 404, client abort, or a neutral end). It must close the circuit,
// release the probe slot, and clear the consecutive-failure chain so the node
// can be scheduled again after any node-local cooldown expires. This is the ONLY
// place that recovers from half-open; it guarantees probeInFlight can never leak.
function recoverFromHalfOpen(s) {
  if (s.circuitState === 'half-open' || s.probeInFlight) {
    s.circuitState = 'closed';
    s.probeInFlight = false;
    s.consecutiveFailures = 0;
  }
}

// ---- Health penalty helper -------------------------------------------------

const PENALTY = {
  rate_limit: 10,
  auth: 30,
  server: 20,
  network: 12,
  client: 0,
};

export function applyHealthPenalty(nodeId, kind) {
  const s = getNodeState(nodeId);
  const amount = PENALTY[kind] ?? 8;
  s.healthScore = Math.max(HEALTH_MIN, s.healthScore - amount);
}

// ---- Maintenance & snapshots ----------------------------------------------

function maybeCleanup(now) {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [, s] of nodeState) {
    if (s.cooldownUntil > 0 && s.cooldownUntil <= now) {
      s.cooldownUntil = 0;
      s.cooldownReason = null;
      s.healthScore = Math.min(HEALTH_MAX, s.healthScore + HEALTH_COOLDOWN_RECOVERY);
    }
    // Drop expired (node, model) cooldowns so the map cannot grow unboundedly.
    if (s.modelCooldowns?.size) {
      for (const [model, until] of s.modelCooldowns) {
        if (until <= now) s.modelCooldowns.delete(model);
      }
    }
    // "Consecutive" must be time-bounded: a failure yesterday and one today
    // are not consecutive. Decay the counter for idle nodes so old incidents
    // cannot accumulate into a circuit trip.
    if (s.activeRequests === 0 && s.consecutiveFailures > 0 && now - s.lastUsedAt > STALE_FAILURE_MS) {
      s.consecutiveFailures = 0;
    }
  }
  if (nodeState.size > MAX_STATE_ENTRIES) {
    const entries = [...nodeState.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    const target = Math.floor(MAX_STATE_ENTRIES * 0.75);
    // Capture `excess` ONCE before the loop: nodeState.delete shrinks
    // nodeState.size inside the loop, so a bound of `nodeState.size - target`
    // would shrink with every deletion and terminate early, leaving the map
    // over MAX_STATE_ENTRIES.
    const excess = nodeState.size - target;
    for (let i = 0; i < excess; i++) nodeState.delete(entries[i][0]);
  }
  // Prune RPM buckets that belong to a previous minute.
  const minute = currentMinute(now);
  for (const [id, bucket] of rpmBuckets) {
    if (bucket.minute !== minute) rpmBuckets.delete(id);
  }
}

export function getCooldownRemainingMs(nodeId, now = Date.now()) {
  const s = getNodeState(nodeId);
  return s.cooldownUntil > now ? s.cooldownUntil - now : 0;
}

export function snapshotNode(nodeId, now = Date.now()) {
  const s = getNodeState(nodeId);
  const cooling = s.cooldownUntil > now;
  return {
    health_score: Math.round(s.healthScore),
    status: cooling ? 'cooling_down' : 'active',
    cooldown_remaining_ms: cooling ? s.cooldownUntil - now : 0,
    cooldown_reason: cooling ? s.cooldownReason : null,
    circuit_state: s.circuitState,
    active_requests: s.activeRequests,
    consecutive_failures: s.consecutiveFailures,
    avg_latency_ms: Math.round(s.avgLatencyMs),
    total_requests: s.totalRequests,
    total_successes: s.totalSuccesses,
    total_failures: s.totalFailures,
    last_used_at: s.lastUsedAt > 0 ? new Date(s.lastUsedAt).toISOString() : null,
  };
}

// Test hook: wipe all isolate-local state between test cases.
export function __resetAllStateForTests() {
  nodeState.clear();
  rpmBuckets.clear();
  lastCleanup = 0;
}
