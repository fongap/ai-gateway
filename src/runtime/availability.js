// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Unified read-only availability surface for the dashboard and any other
// UI that needs to render a model/node status.
//
// Two scheduling state machines exist:
//   Tier 1: src/reliability/tier1-state.js  (account/model, passive TTFT)
//   Tier 2/3: src/reliability/node-state.js  (legacy circuit + cooldown)
//
// Querying either directly from the dashboard is a bug waiting to happen:
// a Tier 1 node that has been disabled, cooled down, or never observed
// will silently look "available" through the legacy peekAvailability()
// because node-state.js creates a default-healthy entry on first read.
//
// This module is the ONLY place the dashboard (and other read-only UIs)
// should query availability. It dispatches to the right state machine
// based on node.tier and returns a normalized tri-state result:
//
//   'available'   - observed AND eligible right now
//   'unobserved'  - configured but no successful observation yet (Tier 1 only)
//   'unavailable' - cooled down, disabled, circuit open, or hard-RPM exhausted
//
// Hot-path cost: one Map lookup per node, no allocation in the steady state.

import { peekAvailability } from '../reliability/node-state.js';
import {
  isTier1Eligible,
  getTier1ModelPerf,
  TIER1_FAILURE_STATES,
} from '../reliability/tier1-state.js';

/**
 * Returns one of: 'available' | 'unobserved' | 'unavailable'
 *
 * @param {object} node  The runtime node object (has .id, .tier, .limits, .protocol, .surfaces, .models).
 * @param {string} [model]  Logical model name; required for Tier 1 to look up the (account, model) pair.
 * @param {Date|number} [now]  Optional clock for deterministic tests.
 * @returns {'available'|'unobserved'|'unavailable'}
 */
export function getRuntimeAvailability(node, model, now = Date.now()) {
  if (!node || typeof node !== 'object') return 'unavailable';
  if (node.tier === 'tier-1') {
    return getTier1Availability(node, model, now);
  }
  return getLegacyAvailability(node, model, now);
}

// Tier 1: state lives in (account, model) maps, not in a single per-node entry.
// A Tier 1 account that has never been touched has no runtime state at all —
// that is 'unobserved', NOT 'available'. The legacy node-state.js would have
// reported 'available' (it lazily creates a default-healthy entry on first
// read), which is exactly the dashboard bug this module exists to fix.
function getTier1Availability(node, model, now) {
  if (!model) return 'unobserved';
  // Build a minimal request descriptor for eligibility check.
  const req = {
    model,
    protocol: node.protocol,
    surface: Array.isArray(node.surfaces) && node.surfaces.length > 0 ? node.surfaces[0] : 'chat_completions',
  };
  if (!isTier1Eligible(node, req, now)) return 'unavailable';
  // Eligible right now. Distinguish "we know this works" from "we have no idea yet".
  const perf = getTier1ModelPerf(node.id, model);
  if (!perf || perf.ttftEwma == null || perf.sampleCount === 0) return 'unobserved';
  if (perf.failureState === TIER1_FAILURE_STATES.HALF_OPEN) return 'unobserved';
  return 'available';
}

// Tier 2/3: legacy state. peekAvailability() returns 'yes'|'probe'|'no'.
// A 'yes' is genuinely "healthy and ready" — the legacy state is required to
// observe a successful dispatch before it goes 'yes' from a fresh default.
// (That default is HEALTH_INITIAL=50, but a Tier 2/3 node still needs to
// survive a real request before the dashboard reports it available.)
function getLegacyAvailability(node, model, now) {
  if (model && node.models && Object.keys(node.models).length > 0 && !node.models[model]) {
    // Node does not serve this specific logical model.
    return 'unavailable';
  }
  const status = peekAvailability(node.id, now);
  if (status === 'yes') return 'available';
  if (status === 'probe') return 'unavailable'; // circuit half-open: still risky
  return 'unavailable';
}
