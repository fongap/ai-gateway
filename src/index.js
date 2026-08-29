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
 *   same-tier rotation, tier fallback, circuit breaker w/ half-open probe
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
import { isCountedRoute, gatewayStats, trackClientResponse } from './observability/stats.js';
import { normalizePath } from './request/router.js';
import { sanitizedInternalError } from './observability/status.js';
import { cleanupModelStats } from './observability/token-store.js';

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

  // Periodic cleanup for the per-model token usage table. Triggered by a cron
  // trigger (configured in wrangler.jsonc). Deletes rows older than the
  // retention period from token_usage_model_hourly ONLY — the global
  // token_usage_hourly table is NEVER pruned because it powers the cumulative
  // KPIs on the public homepage.
  async scheduled(_controller, env, _ctx) {
    // ScheduledController exposes cron/scheduledTime, not a DOM-style `type`.
    // Let a rejection reach the Workers runtime so Cron Trigger status and
    // alerts report a failed run. cleanupModelStats logs the error once.
    await cleanupModelStats(env);
  },
};
