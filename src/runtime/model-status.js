// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Public Model Status — a read-only, cross-isolate aggregate that answers:
//
//   "Does this logical model have credible evidence of serving recently?"
//
// It is intentionally NOT the same as Runtime Availability
// (src/runtime/availability.js). Runtime Availability describes THIS isolate's
// scheduling state (Tier 1 passive TTFT, Tier 2/3 circuit + cooldown) and is
// the correct signal for P2C / cooldown / hedge / failover. Public Model
// Status describes the user-facing service state across isolates, restarts
// and PoPs, because a fresh isolate has no Tier 1 samples even though the
// model is clearly serving fine on other isolates.
//
// Direction (one-way, never reversed):
//
//   Runtime / Observability
//          ↓
//   Public Model Status
//          ↓
//   Dashboard HTML
//
// Public Model Status NEVER feeds back into the scheduler, reliability layer,
// transport, request handler, protocol fallback, hedge or failover. It is a
// pure read-only projection.
//
// Four states (kept stable for the UI):
//   available    at least one credible path AND no current all-down signal
//   degraded     recent evidence exists but current runtime shows partial outage
//   unobserved   configured but no cross-isolate evidence either way
//   unavailable  no configured node serves this model, or every candidate is
//                currently marked unavailable with no recent success
//
// Recent-success evidence source: the existing D1 per-model hourly aggregate
// (token_usage_model_hourly). A row with requests > 0 in the recent window
// means the model successfully completed at least one real request in that
// hour. We do NOT introduce a new persistence table, a new health database, or
// a second statistics system. See queryRecentModelEvidence() in
// token-usage-store.mjs.
//
// Public-safety: this module NEVER reads credentials, node ids, providers or
// tiers into its outputs. The return value is a list of { id, status } only.

import { loadModelRegistry, servesModel } from '../config/registry.js';
import { getRuntimeAvailability } from './availability.js';

// Recent-evidence window. The D1 per-model table stores UTC hourly buckets
// with a 7-day retention (cleanupModelStats prunes older rows). A 24-hour
// window is:
//   * long enough to survive isolate cold-starts and short PoP rotations
//     (a fresh isolate rendering the dashboard still sees yesterday's
//     successful traffic and reports `available`, which is the bug fix);
//   * short enough that a model that has been broken for a full day no
//     longer shows `available` solely from stale evidence;
//   * aligned with the existing hourly bucket granularity, so the query is
//     a single GROUP BY over a small number of rows.
//
// This constant is the ONLY place the window is defined — no scattered magic
// numbers. It is testable directly through getPublicModelStatus().
export const MODEL_STATUS_RECENT_WINDOW_MS = 24 * 3600_000;

// Pure function: compute the public four-state status for every logical
// model known to the gateway (Model Registry ∪ node mappings).
//
// Inputs:
//   nodes     : Runtime Node[] (from loadGatewayConfig(env).nodes)
//   env       : The Worker env (used only to read MODELS_CONFIG via
//               loadModelRegistry, mirroring the previous dashboard
//               implementation's model-name source).
//   evidence  : Set<string> of logical model names with recent-success
//               evidence (typically from queryRecentModelEvidence()). An
//               empty set is the fail-open shape — never null.
//   now       : Optional clock for deterministic tests.
//
// Output:
//   { observed_at: <ISO string>, models: [ { id, status }, ... ] }
//
// The list is sorted by logical model id for stable rendering. No node ids,
// providers, tiers, counts or durations leave this function, and node
// mappings never contribute a model name — the Model Registry is the only
// source of the public model set. A node can only decide whether it can serve
// a registry model; it can never make an undeclared model public.
export function getPublicModelStatus(nodes, env, evidence = new Set(), now = Date.now()) {
  const names = new Set();
  if (env) {
    try {
      const registry = loadModelRegistry(env);
      for (const [name, entry] of Object.entries(registry)) {
        if (entry.visibility !== 'internal') names.add(name);
      }
    } catch { /* registry not loadable in this env — fall back to the empty set */ }
  }
  const evidenceSet = evidence instanceof Set ? evidence : new Set();
  const models = [];
  for (const name of [...names].sort()) {
    const serving = (nodes || []).filter((n) => servesModel(n, name));
    models.push({ id: name, status: modelStatus(name, serving, evidenceSet, now) });
  }
  return { observed_at: new Date(now).toISOString(), models };
}

// Compute the status of one logical model.
function modelStatus(name, serving, evidence, now) {
  if (!serving.length) return 'unavailable';

  const states = serving.map((n) => getRuntimeAvailability(n, name, now));
  const hasRecent = evidence.has(name);

  // At least one candidate is currently available AND eligible.
  const anyAvailable = states.some((s) => s === 'available');
  // At least one candidate is currently unavailable (cooldown / disabled /
  // circuit open / hard-RPM exhausted).
  const anyUnavailable = states.some((s) => s === 'unavailable');
  // At least one candidate is configured-but-unobserved by THIS isolate
  // (Tier 1 with no TTFT sample, or half-open).
  const anyUnobserved = states.some((s) => s === 'unobserved');

  // Case A: every serving candidate is currently unavailable AND there is no
  // recent cross-isolate evidence of success. The model is genuinely down.
  if (!anyAvailable && !anyUnobserved && !hasRecent) return 'unavailable';
  // Case B: every candidate is unavailable right now, but recent cross-isolate
  // evidence says the model was working very recently. That is a partial /
  // transient outage — display `degraded` (still attempting, currently
  // failing). The operator should investigate, not declare the model dead.
  if (!anyAvailable && !anyUnobserved && hasRecent) return 'degraded';
  // Case C: at least one candidate is currently eligible AND observed by this
  // isolate. We do not require recent D1 evidence — the runtime has just
  // confirmed a working path. (If D1 evidence is also present, it only
  // strengthens the same `available` conclusion.)
  if (anyAvailable) return 'available';
  // Case D: no candidate is currently `available`, but at least one is
  // `unobserved` (fresh isolate, no TTFT sample). The honest answer depends
  // on whether we have cross-isolate evidence:
  //   * recent D1 success -> `available` (a fresh isolate not having TTFT
  //     does not contradict the model actually serving);
  //   * no recent D1 success -> `unobserved` (we have no signal either way).
  if (hasRecent) return 'available';
  // Case E: mixed unobserved / unavailable, no recent evidence. We cannot
  // claim `available`, but we also cannot rule out that the unobserved
  // candidates work — the honest status is `unobserved` (not `unavailable`,
  // which would require every candidate to be confirmed down).
  if (anyUnobserved) return 'unobserved';
  // Fallback: all candidates are unavailable and there is no recent
  // evidence, but the loop above already returned `unavailable`. This branch
  // is unreachable; we keep it defensive rather than silently returning
  // `available`.
  return 'unavailable';
}