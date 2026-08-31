// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Low-frequency active TTFT probes.  Passive request measurements remain the
// source of truth, but a tiny probe lets a cold or stale (node, model) pair
// learn its current first-token speed before it receives a real request.
//
// Probes are deliberately conservative:
//   - Tier 1 only: paid Tier 2 / Tier 3 nodes are never probed;
//   - one probe per isolate at a time, at most one new probe every 30 seconds;
//   - a (node, model) pair is sampled at most once every five minutes;
//   - a probe leaves one configured concurrency slot unused for real traffic;
//   - it never spends the final hard-RPM request available to a user.
//
// They run exclusively through ExecutionContext.waitUntil(), so no client
// response awaits them.  A probe records only TTFT; it neither rewards nor
// penalizes node health because its deliberately tiny prompt is not a real
// workload.

import { buildTargetUrl } from '../protocol/http.js';
import { resolveUpstreamPath, buildUpstreamHeadersFor, isAnthropicNativeRealOutput, isResponsesRealOutput } from '../transport/index.js';
import { ensureFirstSseEvent } from '../stream/guard.js';
import { supportsRequest, isHardRpmExhausted } from './scheduler.js';
import { acquireSlot, getModelPerf, getNodeState, isModelCooling, markProbeFailure, peekAvailability, recordNeutralEnd, recordTtft, rpmUsage } from '../reliability/node-state.js';

const PROBE_INTERVAL_MS = 5 * 60_000;
const PROBE_GLOBAL_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 8_000;

let probesInFlight = 0;
let lastProbeStartedAt = 0;

export function scheduleModelProbe(ctx, { nodes, model, protocol, surface, env, logger } = {}) {
  if (!ctx || typeof ctx.waitUntil !== 'function' || !Array.isArray(nodes) || !model) return false;
  const target = selectProbeTarget(nodes, { model, protocol, surface });
  if (!target) return false;
  const task = runModelProbe(target, { model, surface, env, logger }).catch(() => {});
  try {
    ctx.waitUntil(task);
    return true;
  } catch {
    task.catch(() => {});
    return false;
  }
}

function selectProbeTarget(nodes, request) {
  const now = Date.now();
  if (probesInFlight > 0 || now - lastProbeStartedAt < PROBE_GLOBAL_INTERVAL_MS) return null;
  let best = null;
  let bestAge = -1;
  for (const node of nodes) {
    // Background requests are reserved exclusively for free Tier 1 capacity.
    // Tier 2 / Tier 3 are paid fallbacks and may only be contacted by an
    // actual user request that reached that tier.
    if (node.tier !== 'tier-1') continue;
    if (!supportsRequest(node, request)) continue;
    if (peekAvailability(node.id, now) === 'no' || isModelCooling(node.id, request.model, now)) continue;
    const state = getNodeState(node.id);
    // Never let background work consume the last slot available to users.
    if (state.activeRequests >= Math.max(0, node.limits.concurrency - 1)) continue;
    // Likewise, do not consume the final request below a hard RPM cap.
    if (node.limits.rpm && rpmUsage(node.id, now) >= Math.max(0, node.limits.rpm - 1)) continue;
    if (isHardRpmExhausted(node, now)) continue;
    const perf = getModelPerf(node.id, request.model);
    const age = perf ? now - perf.lastUsedAt : Infinity;
    if (age < PROBE_INTERVAL_MS || age <= bestAge) continue;
    best = node;
    bestAge = age;
  }
  if (!best) return null;
  // Claim synchronously before the task can yield.  This reserves real
  // concurrency/RPM capacity and makes the global gate race-free in one
  // Worker isolate.
  if (!acquireSlot(best.id, now)) return null;
  probesInFlight++;
  lastProbeStartedAt = now;
  return best;
}

async function runModelProbe(node, { model, surface, env, logger }) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const upstreamModel = node.models[model] || model;
    const body = JSON.stringify(probeBody(node.protocol, surface, upstreamModel));
    const probeRequest = new Request('https://probe.invalid/', {
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    });
    const response = await fetch(buildTargetUrl(node.baseUrl, resolveUpstreamPath(node.protocol, surface)), {
      method: 'POST',
      headers: buildUpstreamHeadersFor(node.protocol, probeRequest, node.credential, `probe-${crypto.randomUUID()}`),
      body,
      signal: controller.signal,
    });
    if (!response.ok) return;
    const first = await ensureFirstSseEvent(response, PROBE_TIMEOUT_MS, controller.signal, realOutputPredicate(node.protocol, surface));
    recordTtft(node.id, Date.now() - startedAt, model, { source: 'probe' });
    await first.body?.cancel().catch(() => {});
  } catch {
    // A probe is advisory only.  Real request failures remain the sole input
    // to health penalties, cooldowns and circuit transitions.  But a probe
    // failure must invalidate the stale TTFT so an old fast score cannot
    // remain decisive — the node may have degraded since it was last measured.
    markProbeFailure(node.id, model);
  } finally {
    clearTimeout(timeoutId);
    recordNeutralEnd(node.id);
    probesInFlight = Math.max(0, probesInFlight - 1);
    try { logger?.debug?.(`model probe complete: node=${node.id} model=${model}`); } catch { /* diagnostic only */ }
  }
}

function probeBody(protocol, surface, model) {
  if (protocol === 'anthropic') {
    return { model, stream: true, max_tokens: 1, messages: [{ role: 'user', content: 'Reply: 1' }] };
  }
  if (surface === 'responses') {
    return { model, stream: true, max_output_tokens: 1, input: 'Reply: 1' };
  }
  return { model, stream: true, max_tokens: 1, temperature: 0, messages: [{ role: 'user', content: 'Reply: 1' }] };
}

function realOutputPredicate(protocol, surface) {
  if (protocol === 'anthropic') return isAnthropicNativeRealOutput;
  if (surface === 'responses') return isResponsesRealOutput;
  return undefined;
}

export function __resetModelProbesForTests() {
  probesInFlight = 0;
  lastProbeStartedAt = 0;
}
