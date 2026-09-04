// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Token Usage Writer.
//
// Owns: persistTokenUsage (the single hot-path write called from the
// request handler inside ctx.waitUntil), plus the per-bucket
// persistence helpers (totals, hourly, per-model + TTFT histogram).
//
// Invariant:
//   requests = usage_reports + usage_missing
// within the set of completed-and-entered-token-stats AI responses.
//
// On failure: returns a rejected Promise. The caller is responsible
// for fail-open handling (ctx.waitUntil().catch()). The per-model
// write failure is independent of the global aggregate; the global
// failure dominates when both reject so the request-level caller
// still emits exactly one diagnostic.

import { normalizeTokenUsage } from '../token-usage.mjs';
import {
  TABLE, TABLE_MODEL, TABLE_TOTALS,
  TTFT_BUCKET_COUNT, TTFT_BUCKET_BOUNDARIES_MS,
  normalizeHour, tokenStatsD1, normalizeModelKey, ttftBucketIndex,
} from './keys.js';

// Derive the D1 aggregate payload for ONE delivered response from a
// raw upstream usage object. Exactly one of { reports: 1 } or {
// missing: 1 } is set; a normalized report carries its token totals.
// Returns null only when a caller passes something structurally
// unusable (defensive) — in practice the caller always passes either
// a usage object or null/undefined.
export function tokenUsagePayload(usage) {
  const normalized = normalizeTokenUsage(usage);
  if (normalized) {
    return {
      input: normalized.input,
      output: normalized.output,
      total: normalized.total,
      requests: 1,
      reports: 1,
      missing: 0,
    };
  }
  return { input: 0, output: 0, total: 0, requests: 1, reports: 0, missing: 1 };
}

function persistFailure(scope, cause, model = null) {
  const error = new Error(cause?.message || String(cause || 'D1 persistence failure'), { cause });
  error.name = 'TokenStatsPersistError';
  error.scope = scope;
  if (model) error.model = model;
  return error;
}

// Atomic per-hour UPSERT. One call = one response; the hour bucket is
// incremented by a single SQL statement so two isolates updating the
// same hour never lose a count (no SELECT-then-UPDATE race). `usage`
// is the RAW upstream usage (or null/undefined); it is normalized
// here, so a report and a missing response each produce exactly one
// payload. When `model` is a non-empty string, a parallel per-model
// UPSERT is fired (used by the homepage's "模型使用 · 近 7 天"
// panel). The per-model write is independent: its failure does not
// roll back the global aggregate. Additionally, the lifetime totals
// row (scope='global') is updated atomically. Returns a Promise that
// settles once ALL writes complete; a single classified rejection
// surfaces through the catch in the caller, which guarantees at
// most one log entry per delivered response. May reject — the
// caller is responsible for fail-open handling.
//
// `ttftMs` (optional) — successful TTFT in milliseconds. Only
// meaningful requests (success + meaningful output) should pass a
// value; failures MUST pass null/undefined so they never produce a
// TTFT sample. The value is bucketed into a coarse histogram
// (ttft_b0..ttft_b6) for percentile calculation without storing raw
// samples.
export function persistTokenUsage(env, usage, now = Date.now(), model = null, ttftMs = null) {
  const d1 = tokenStatsD1(env);
  if (!d1) return Promise.resolve();
  const hour = normalizeHour(now);
  const p = tokenUsagePayload(usage);
  let globalTask;
  try {
    const globalStmt = d1.prepare(
      `INSERT INTO ${TABLE} (
        hour,
        input_tokens,
        output_tokens,
        total_tokens,
        requests,
        usage_reports,
        usage_missing
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour) DO UPDATE SET
        input_tokens = ${TABLE}.input_tokens + excluded.input_tokens,
        output_tokens = ${TABLE}.output_tokens + excluded.output_tokens,
        total_tokens = ${TABLE}.total_tokens + excluded.total_tokens,
        requests = ${TABLE}.requests + excluded.requests,
        usage_reports = ${TABLE}.usage_reports + excluded.usage_reports,
        usage_missing = ${TABLE}.usage_missing + excluded.usage_missing`,
    );
    globalTask = Promise.resolve(globalStmt.bind(
      hour,
      p.input,
      p.output,
      p.total,
      p.requests,
      p.reports,
      p.missing,
    ).run());
  } catch (cause) {
    return Promise.reject(persistFailure('global', cause));
  }

  // Lifetime totals UPSERT (single row 'global'). Fail-open: errors
  // are logged but do not block the request path.
  let totalsTask;
  try {
    const totalsStmt = d1.prepare(
      `INSERT INTO ${TABLE_TOTALS} (
        scope, input_tokens, output_tokens, total_tokens,
        requests, usage_reports, usage_missing, updated_at
      )
      VALUES ('global', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        input_tokens = ${TABLE_TOTALS}.input_tokens + excluded.input_tokens,
        output_tokens = ${TABLE_TOTALS}.output_tokens + excluded.output_tokens,
        total_tokens = ${TABLE_TOTALS}.total_tokens + excluded.total_tokens,
        requests = ${TABLE_TOTALS}.requests + excluded.requests,
        usage_reports = ${TABLE_TOTALS}.usage_reports + excluded.usage_reports,
        usage_missing = ${TABLE_TOTALS}.usage_missing + excluded.usage_missing,
        updated_at = excluded.updated_at`,
    );
    totalsTask = Promise.resolve(totalsStmt.bind(
      p.input,
      p.output,
      p.total,
      p.requests,
      p.reports,
      p.missing,
      new Date(now).toISOString(),
    ).run());
  } catch (cause) {
    // Log but don't fail the request for totals write failures.
    console.error('token-stats totals persist failed:', cause?.message || cause);
    totalsTask = Promise.resolve();
  }

  if (typeof model !== 'string' || model.length === 0) {
    return Promise.allSettled([globalTask, totalsTask]).then(([globalResult, totalsResult]) => {
      if (globalResult.status === 'rejected') throw persistFailure('global', globalResult.reason);
      // totals failures already logged silently.
    });
  }
  const canonicalModel = normalizeModelKey(model);

  // Compute TTFT histogram bucket counts for this single sample.
  // Only successful requests with meaningful output pass a valid
  // ttftMs; failures pass null so they never produce a TTFT sample.
  const buckets = Array.from({ length: TTFT_BUCKET_COUNT }, () => 0);
  let successTtftCount = 0;
  if (ttftMs != null) {
    const bi = ttftBucketIndex(ttftMs);
    if (bi >= 0) {
      buckets[bi] = 1;
      successTtftCount = 1;
    }
  }
  let modelTask;
  try {
    modelTask = Promise.resolve(d1.prepare(
      `INSERT INTO ${TABLE_MODEL} (
        hour, model,
        input_tokens, output_tokens, total_tokens,
        requests, usage_reports, usage_missing,
        successful_ttft_count,
        ttft_b0, ttft_b1, ttft_b2, ttft_b3, ttft_b4, ttft_b5, ttft_b6
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour, model) DO UPDATE SET
        input_tokens = ${TABLE_MODEL}.input_tokens + excluded.input_tokens,
        output_tokens = ${TABLE_MODEL}.output_tokens + excluded.output_tokens,
        total_tokens = ${TABLE_MODEL}.total_tokens + excluded.total_tokens,
        requests = ${TABLE_MODEL}.requests + excluded.requests,
        usage_reports = ${TABLE_MODEL}.usage_reports + excluded.usage_reports,
        usage_missing = ${TABLE_MODEL}.usage_missing + excluded.usage_missing,
        successful_ttft_count = ${TABLE_MODEL}.successful_ttft_count + excluded.successful_ttft_count,
        ttft_b0 = ${TABLE_MODEL}.ttft_b0 + excluded.ttft_b0,
        ttft_b1 = ${TABLE_MODEL}.ttft_b1 + excluded.ttft_b1,
        ttft_b2 = ${TABLE_MODEL}.ttft_b2 + excluded.ttft_b2,
        ttft_b3 = ${TABLE_MODEL}.ttft_b3 + excluded.ttft_b3,
        ttft_b4 = ${TABLE_MODEL}.ttft_b4 + excluded.ttft_b4,
        ttft_b5 = ${TABLE_MODEL}.ttft_b5 + excluded.ttft_b5,
        ttft_b6 = ${TABLE_MODEL}.ttft_b6 + excluded.ttft_b6`,
    ).bind(
      hour, canonicalModel,
      p.input, p.output, p.total,
      p.requests, p.reports, p.missing,
      successTtftCount,
      buckets[0], buckets[1], buckets[2], buckets[3], buckets[4], buckets[5], buckets[6],
    ).run());
  } catch (cause) {
    modelTask = Promise.reject(cause);
  }
  return Promise.allSettled([globalTask, totalsTask, modelTask]).then(([globalResult, totalsResult, modelResult]) => {
    // Prefer the global aggregate failure when both writes fail: it
    // is the more important loss, and the request-level caller still
    // emits exactly one diagnostic. Promise.allSettled also observes
    // both rejections, so no secondary unhandled rejection can
    // escape.
    if (globalResult.status === 'rejected') throw persistFailure('global', globalResult.reason);
    if (modelResult.status === 'rejected') throw persistFailure('per-model', modelResult.reason, model);
    // totals failures already logged silently.
  });
}
