// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Route Feasibility — the single shared predicate that decides whether a
// request has ANY legal execution path before it enters orchestration.
//
// "Native First, not Native Only": a request is routable when EITHER a native
// candidate exists (same protocol+surface as the client route) OR at least one
// explicitly configured, Gateway-supported cross-protocol fallback has a
// candidate for the requested model. When neither holds, preflight returns 404
// and the request never reaches the tier loop or the fallback chain.
//
// This helper exists so preflight.js, handler.js and fallback.js never each
// re-implement the "is there a reachable route" judgment with subtly different
// logic. It is purely a static config/model check — it does NOT inspect runtime
// availability, circuit state, cooldowns or the attempted set (those are
// dispatch-time gates owned by the scheduler). The result is therefore stable
// for the lifetime of a single request and may be computed once and carried
// through the pipeline.

import { supportsRequest } from '../scheduler/scheduler.js';
import { TIER_ORDER } from './router.js';
import { getFallbackChain } from '../config/protocol-fallbacks.js';

/**
 * Evaluate whether a request has any reachable execution path.
 *
 * @param {{
 *   route: string,
 *   requestedModel: string,
 *   requestDescriptor: { model: string, protocol: string, surface: string },
 *   tiers: { 1: any[], 2: any[], 3: any[] },
 *   knownModels: Set<string>,
 *   env: any,
 * }} args
 * @returns {{
 *   reachable: boolean,
 *   nativeSupported: boolean,
 *   fallbackSupported: boolean,
 *   fallbacks: { protocol: string, surface: string }[],
 * }}
 */
export function evaluateRouteFeasibility({ route, requestedModel, requestDescriptor, tiers, knownModels, env }) {
  const nativeSupported = TIER_ORDER.some((t) =>
    tiers[t].some((n) => supportsRequest(n, requestDescriptor, knownModels)));

  const fallbacks = [];
  for (const fb of getFallbackChain(route, env)) {
    const fbReqDescriptor = { model: requestedModel, protocol: fb.protocol, surface: fb.surface };
    if (TIER_ORDER.some((t) =>
      tiers[t].some((n) => supportsRequest(n, fbReqDescriptor, knownModels)))) {
      fallbacks.push({ protocol: fb.protocol, surface: fb.surface });
    }
  }

  return {
    reachable: nativeSupported || fallbacks.length > 0,
    nativeSupported,
    fallbackSupported: fallbacks.length > 0,
    fallbacks,
  };
}
