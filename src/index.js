/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Fongap Studio
 *
 * ai-gateway — aggregate many upstream AI APIs / keys into one stable
 * endpoint on Cloudflare Workers.
 *
 *   many APIs · many keys · many models
 *        ↓
 *   node selection / load spreading (priority + concurrency)
 *   429 isolation with Retry-After cooldowns
 *   Tier 1 affinity/P2C/passive learning, tier fallback, Tier 2/3 circuit recovery
 *   first-event streaming guard
 *        ↓
 *   the client sees a single stable endpoint
 *
 * This file is ONLY the Worker entry: request counting and the top-level
 * error boundary. All logic lives in src/config, src/scheduler,
 * src/reliability, src/protocol, src/stream, src/request, src/observability.
 *
 * State is isolate-local best-effort (Map); no KV/D1/DO on the hot path.
 */

import { handleRequest } from './request/handler.js';
import { isCountedRoute, gatewayStats, trackClientResponse } from './observability/gateway-stats.mjs';
import { normalizePath } from './request/router.js';
import { sanitizedInternalError } from './observability/diagnostic-endpoints.mjs';
import { maintainUsageStats } from './observability/token-usage-store.mjs';

export default {
  async fetch(request, env, ctx) {
    const pathname = normalizePath(new URL(request.url).pathname);
    const counted = isCountedRoute(request.method.toUpperCase(), pathname);
    if (counted) {
      gatewayStats.requests++;
      gatewayStats.activeRequests++;
    }
    try {
      const response = await handleRequest(request, env, ctx);
      return counted ? trackClientResponse(response) : response;
    } catch (error) {
      if (counted) {
        gatewayStats.activeRequests = Math.max(0, gatewayStats.activeRequests - 1);
        gatewayStats.failures++;
        if (request.signal?.aborted) gatewayStats.cancellations++;
      }
      console.error('unhandled gateway error:', error?.message || error);
      const isAnthropic = /messages/.test(pathname);
      return sanitizedInternalError(request, env, isAnthropic, crypto.randomUUID().slice(0, 8));
    }
  },

  // Periodic maintenance for token usage tables. Triggered by a cron
  // trigger (configured in wrangler.jsonc). Runs:
  //   1. Aggregate hourly → daily (idempotent overwrite)
  //   2. Aggregate daily → weekly (idempotent overwrite)
  //   3. Retention cleanup for hourly (7d), daily (52w), weekly (52w)
  // All operations are idempotent and fail-open for the API path.
  async scheduled(_controller, env, _ctx) {
    await maintainUsageStats(env);
  },
};
