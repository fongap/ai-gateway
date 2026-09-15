// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Token Usage Writer.
//
// Two accounting views intentionally coexist in the SAME aggregate tables:
//
//   delivered columns  — one successfully delivered response; these keep the
//                        established model-status / TTFT evidence semantics.
//   upstream_* columns — one real physical upstream dispatch, including failed
//                        fallback/retry/hedge work. Tokens are counted only
//                        when the upstream actually reports usage; missing
//                        reports are counted and NEVER estimated.
//
// A successfully delivered response is also one physical upstream attempt, so
// persistTokenUsage() updates both views atomically in the same SQL statements.
// Non-delivered physical attempts use persistUpstreamAttemptUsage(), which
// touches only upstream_* columns and therefore cannot fabricate success
// evidence in `requests` / `usage_reports` / TTFT histograms.

import { normalizeTokenUsage } from '../token-usage.ts';
import {
  TABLE, TABLE_MODEL, TABLE_TOTALS,
  TTFT_BUCKET_COUNT,
  normalizeHour, tokenStatsD1, normalizeModelKey, ttftBucketIndex,
} from './keys.ts';
import type { NormalizedTokenUsage } from '../token-usage.ts';

type UsagePayload = {
  input: number,
  output: number,
  cacheCreation: number,
  cacheRead: number,
  total: number,
  requests: number,
  reports: number,
  missing: number,
};

export function tokenUsagePayload(usage: unknown): UsagePayload {
  const normalized: NormalizedTokenUsage | null = normalizeTokenUsage(usage);
  if (normalized) {
    return {
      input: normalized.input,
      output: normalized.output,
      cacheCreation: normalized.cacheCreation,
      cacheRead: normalized.cacheRead,
      total: normalized.total,
      requests: 1,
      reports: 1,
      missing: 0,
    };
  }
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, requests: 1, reports: 0, missing: 1 };
}

function persistFailure(scope: string, cause: unknown, model: string | null = null): Error & { scope: string, model?: string } {
  const rawMessage = (cause as { message?: unknown } | null | undefined)?.message || String(cause || 'D1 persistence failure');
  const error = new Error(String(rawMessage), { cause }) as Error & { scope: string, model?: string };
  error.name = 'TokenStatsPersistError';
  error.scope = scope;
  if (model) error.model = model;
  return error;
}

// Persist one SUCCESSFULLY DELIVERED response. The legacy parameter prefix in
// every statement remains unchanged; upstream columns are appended. Besides
// easing rolling compatibility, this protects the independently tested TTFT /
// success-evidence contract from accidental positional drift.
export function persistTokenUsage(env: Record<string, unknown>, usage: unknown, now: number = Date.now(), model: string | null = null, ttftMs: number | null = null): Promise<void> {
  const d1 = tokenStatsD1(env);
  if (!d1) return Promise.resolve();
  const hour = normalizeHour(now);
  const p = tokenUsagePayload(usage);
  let globalTask: Promise<unknown>;
  try {
    const globalStmt = d1.prepare(
      `INSERT INTO ${TABLE} (
        hour,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens,
        requests, usage_reports, usage_missing,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour) DO UPDATE SET
        input_tokens = ${TABLE}.input_tokens + excluded.input_tokens,
        output_tokens = ${TABLE}.output_tokens + excluded.output_tokens,
        cache_creation_input_tokens = ${TABLE}.cache_creation_input_tokens + excluded.cache_creation_input_tokens,
        cache_read_input_tokens = ${TABLE}.cache_read_input_tokens + excluded.cache_read_input_tokens,
        total_tokens = ${TABLE}.total_tokens + excluded.total_tokens,
        requests = ${TABLE}.requests + excluded.requests,
        usage_reports = ${TABLE}.usage_reports + excluded.usage_reports,
        usage_missing = ${TABLE}.usage_missing + excluded.usage_missing,
        upstream_input_tokens = ${TABLE}.upstream_input_tokens + excluded.upstream_input_tokens,
        upstream_output_tokens = ${TABLE}.upstream_output_tokens + excluded.upstream_output_tokens,
        upstream_cache_creation_input_tokens = ${TABLE}.upstream_cache_creation_input_tokens + excluded.upstream_cache_creation_input_tokens,
        upstream_cache_read_input_tokens = ${TABLE}.upstream_cache_read_input_tokens + excluded.upstream_cache_read_input_tokens,
        upstream_total_tokens = ${TABLE}.upstream_total_tokens + excluded.upstream_total_tokens,
        upstream_attempts = ${TABLE}.upstream_attempts + excluded.upstream_attempts,
        upstream_usage_reports = ${TABLE}.upstream_usage_reports + excluded.upstream_usage_reports,
        upstream_usage_missing = ${TABLE}.upstream_usage_missing + excluded.upstream_usage_missing`,
    );
    globalTask = Promise.resolve(globalStmt.bind(
      hour,
      p.input, p.output, p.cacheCreation, p.cacheRead, p.total, p.requests, p.reports, p.missing,
      p.input, p.output, p.cacheCreation, p.cacheRead, p.total, p.requests, p.reports, p.missing,
    ).run());
  } catch (cause) {
    return Promise.reject(persistFailure('global', cause));
  }

  let totalsTask: Promise<unknown>;
  try {
    const totalsStmt = d1.prepare(
      `INSERT INTO ${TABLE_TOTALS} (
        scope,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens,
        requests, usage_reports, usage_missing, updated_at,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing
      )
      VALUES ('global', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        input_tokens = ${TABLE_TOTALS}.input_tokens + excluded.input_tokens,
        output_tokens = ${TABLE_TOTALS}.output_tokens + excluded.output_tokens,
        cache_creation_input_tokens = ${TABLE_TOTALS}.cache_creation_input_tokens + excluded.cache_creation_input_tokens,
        cache_read_input_tokens = ${TABLE_TOTALS}.cache_read_input_tokens + excluded.cache_read_input_tokens,
        total_tokens = ${TABLE_TOTALS}.total_tokens + excluded.total_tokens,
        requests = ${TABLE_TOTALS}.requests + excluded.requests,
        usage_reports = ${TABLE_TOTALS}.usage_reports + excluded.usage_reports,
        usage_missing = ${TABLE_TOTALS}.usage_missing + excluded.usage_missing,
        updated_at = excluded.updated_at,
        upstream_input_tokens = ${TABLE_TOTALS}.upstream_input_tokens + excluded.upstream_input_tokens,
        upstream_output_tokens = ${TABLE_TOTALS}.upstream_output_tokens + excluded.upstream_output_tokens,
        upstream_cache_creation_input_tokens = ${TABLE_TOTALS}.upstream_cache_creation_input_tokens + excluded.upstream_cache_creation_input_tokens,
        upstream_cache_read_input_tokens = ${TABLE_TOTALS}.upstream_cache_read_input_tokens + excluded.upstream_cache_read_input_tokens,
        upstream_total_tokens = ${TABLE_TOTALS}.upstream_total_tokens + excluded.upstream_total_tokens,
        upstream_attempts = ${TABLE_TOTALS}.upstream_attempts + excluded.upstream_attempts,
        upstream_usage_reports = ${TABLE_TOTALS}.upstream_usage_reports + excluded.upstream_usage_reports,
        upstream_usage_missing = ${TABLE_TOTALS}.upstream_usage_missing + excluded.upstream_usage_missing`,
    );
    totalsTask = Promise.resolve(totalsStmt.bind(
      p.input, p.output, p.cacheCreation, p.cacheRead, p.total, p.requests, p.reports, p.missing,
      new Date(now).toISOString(),
      p.input, p.output, p.cacheCreation, p.cacheRead, p.total, p.requests, p.reports, p.missing,
    ).run());
  } catch (cause) {
    console.error('token-stats totals persist failed:', (cause as { message?: unknown } | null | undefined)?.message || cause);
    totalsTask = Promise.resolve();
  }

  if (typeof model !== 'string' || model.length === 0) {
    return Promise.allSettled([globalTask, totalsTask]).then(([globalResult]) => {
      if (globalResult.status === 'rejected') throw persistFailure('global', globalResult.reason);
    });
  }
  const canonicalModel = normalizeModelKey(model);

  const buckets = Array.from({ length: TTFT_BUCKET_COUNT }, () => 0);
  let successTtftCount = 0;
  if (ttftMs != null) {
    const bi = ttftBucketIndex(ttftMs);
    if (bi >= 0) {
      buckets[bi] = 1;
      successTtftCount = 1;
    }
  }
  let modelTask: Promise<unknown>;
  try {
    modelTask = Promise.resolve(d1.prepare(
      `INSERT INTO ${TABLE_MODEL} (
        hour, model,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, total_tokens,
        requests, usage_reports, usage_missing,
        successful_ttft_count,
        ttft_b0, ttft_b1, ttft_b2, ttft_b3, ttft_b4, ttft_b5, ttft_b6,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour, model) DO UPDATE SET
        input_tokens = ${TABLE_MODEL}.input_tokens + excluded.input_tokens,
        output_tokens = ${TABLE_MODEL}.output_tokens + excluded.output_tokens,
        cache_creation_input_tokens = ${TABLE_MODEL}.cache_creation_input_tokens + excluded.cache_creation_input_tokens,
        cache_read_input_tokens = ${TABLE_MODEL}.cache_read_input_tokens + excluded.cache_read_input_tokens,
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
        ttft_b6 = ${TABLE_MODEL}.ttft_b6 + excluded.ttft_b6,
        upstream_input_tokens = ${TABLE_MODEL}.upstream_input_tokens + excluded.upstream_input_tokens,
        upstream_output_tokens = ${TABLE_MODEL}.upstream_output_tokens + excluded.upstream_output_tokens,
        upstream_cache_creation_input_tokens = ${TABLE_MODEL}.upstream_cache_creation_input_tokens + excluded.upstream_cache_creation_input_tokens,
        upstream_cache_read_input_tokens = ${TABLE_MODEL}.upstream_cache_read_input_tokens + excluded.upstream_cache_read_input_tokens,
        upstream_total_tokens = ${TABLE_MODEL}.upstream_total_tokens + excluded.upstream_total_tokens,
        upstream_attempts = ${TABLE_MODEL}.upstream_attempts + excluded.upstream_attempts,
        upstream_usage_reports = ${TABLE_MODEL}.upstream_usage_reports + excluded.upstream_usage_reports,
        upstream_usage_missing = ${TABLE_MODEL}.upstream_usage_missing + excluded.upstream_usage_missing`,
    ).bind(
      hour, canonicalModel,
      p.input, p.output, p.cacheCreation, p.cacheRead, p.total, p.requests, p.reports, p.missing,
      successTtftCount,
      buckets[0], buckets[1], buckets[2], buckets[3], buckets[4], buckets[5], buckets[6],
      p.input, p.output, p.cacheCreation, p.cacheRead, p.total, p.requests, p.reports, p.missing,
    ).run());
  } catch (cause) {
    modelTask = Promise.reject(cause);
  }
  return Promise.allSettled([globalTask, totalsTask, modelTask]).then(([globalResult, , modelResult]) => {
    if (globalResult.status === 'rejected') throw persistFailure('global', globalResult.reason);
    if (modelResult.status === 'rejected') throw persistFailure('per-model', modelResult.reason, model);
  });
}

// Persist one physical upstream attempt that did NOT become the delivered
// response (failure, retry/fallback loss, hedge loser, or client-cancelled live
// upstream). This function never touches delivered `requests`, `usage_reports`,
// TTFT or success evidence.
export function persistUpstreamAttemptUsage(
  env: Record<string, unknown>,
  usage: unknown,
  now: number = Date.now(),
  model: string | null = null,
): Promise<void> {
  const d1 = tokenStatsD1(env);
  if (!d1) return Promise.resolve();
  const hour = normalizeHour(now);
  const p = tokenUsagePayload(usage);

  let globalTask: Promise<unknown>;
  try {
    globalTask = Promise.resolve(d1.prepare(
      `INSERT INTO ${TABLE} (
        hour,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour) DO UPDATE SET
        upstream_input_tokens = ${TABLE}.upstream_input_tokens + excluded.upstream_input_tokens,
        upstream_output_tokens = ${TABLE}.upstream_output_tokens + excluded.upstream_output_tokens,
        upstream_cache_creation_input_tokens = ${TABLE}.upstream_cache_creation_input_tokens + excluded.upstream_cache_creation_input_tokens,
        upstream_cache_read_input_tokens = ${TABLE}.upstream_cache_read_input_tokens + excluded.upstream_cache_read_input_tokens,
        upstream_total_tokens = ${TABLE}.upstream_total_tokens + excluded.upstream_total_tokens,
        upstream_attempts = ${TABLE}.upstream_attempts + excluded.upstream_attempts,
        upstream_usage_reports = ${TABLE}.upstream_usage_reports + excluded.upstream_usage_reports,
        upstream_usage_missing = ${TABLE}.upstream_usage_missing + excluded.upstream_usage_missing`,
    ).bind(hour, p.input, p.output, p.cacheCreation, p.cacheRead, p.total, p.requests, p.reports, p.missing).run());
  } catch (cause) {
    return Promise.reject(persistFailure('upstream-global', cause));
  }

  let totalsTask: Promise<unknown>;
  try {
    totalsTask = Promise.resolve(d1.prepare(
      `INSERT INTO ${TABLE_TOTALS} (
        scope,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing,
        updated_at
      ) VALUES ('global', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        upstream_input_tokens = ${TABLE_TOTALS}.upstream_input_tokens + excluded.upstream_input_tokens,
        upstream_output_tokens = ${TABLE_TOTALS}.upstream_output_tokens + excluded.upstream_output_tokens,
        upstream_cache_creation_input_tokens = ${TABLE_TOTALS}.upstream_cache_creation_input_tokens + excluded.upstream_cache_creation_input_tokens,
        upstream_cache_read_input_tokens = ${TABLE_TOTALS}.upstream_cache_read_input_tokens + excluded.upstream_cache_read_input_tokens,
        upstream_total_tokens = ${TABLE_TOTALS}.upstream_total_tokens + excluded.upstream_total_tokens,
        upstream_attempts = ${TABLE_TOTALS}.upstream_attempts + excluded.upstream_attempts,
        upstream_usage_reports = ${TABLE_TOTALS}.upstream_usage_reports + excluded.upstream_usage_reports,
        upstream_usage_missing = ${TABLE_TOTALS}.upstream_usage_missing + excluded.upstream_usage_missing,
        updated_at = excluded.updated_at`,
    ).bind(
      p.input, p.output, p.cacheCreation, p.cacheRead, p.total,
      p.requests, p.reports, p.missing,
      new Date(now).toISOString(),
    ).run());
  } catch (cause) {
    console.error('upstream token-stats totals persist failed:', (cause as { message?: unknown } | null | undefined)?.message || cause);
    totalsTask = Promise.resolve();
  }

  if (typeof model !== 'string' || model.length === 0) {
    return Promise.allSettled([globalTask, totalsTask]).then(([globalResult]) => {
      if (globalResult.status === 'rejected') throw persistFailure('upstream-global', globalResult.reason);
    });
  }

  const canonicalModel = normalizeModelKey(model);
  let modelTask: Promise<unknown>;
  try {
    modelTask = Promise.resolve(d1.prepare(
      `INSERT INTO ${TABLE_MODEL} (
        hour, model,
        upstream_input_tokens, upstream_output_tokens,
        upstream_cache_creation_input_tokens, upstream_cache_read_input_tokens, upstream_total_tokens,
        upstream_attempts, upstream_usage_reports, upstream_usage_missing
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour, model) DO UPDATE SET
        upstream_input_tokens = ${TABLE_MODEL}.upstream_input_tokens + excluded.upstream_input_tokens,
        upstream_output_tokens = ${TABLE_MODEL}.upstream_output_tokens + excluded.upstream_output_tokens,
        upstream_cache_creation_input_tokens = ${TABLE_MODEL}.upstream_cache_creation_input_tokens + excluded.upstream_cache_creation_input_tokens,
        upstream_cache_read_input_tokens = ${TABLE_MODEL}.upstream_cache_read_input_tokens + excluded.upstream_cache_read_input_tokens,
        upstream_total_tokens = ${TABLE_MODEL}.upstream_total_tokens + excluded.upstream_total_tokens,
        upstream_attempts = ${TABLE_MODEL}.upstream_attempts + excluded.upstream_attempts,
        upstream_usage_reports = ${TABLE_MODEL}.upstream_usage_reports + excluded.upstream_usage_reports,
        upstream_usage_missing = ${TABLE_MODEL}.upstream_usage_missing + excluded.upstream_usage_missing`,
    ).bind(
      hour, canonicalModel,
      p.input, p.output, p.cacheCreation, p.cacheRead, p.total,
      p.requests, p.reports, p.missing,
    ).run());
  } catch (cause) {
    modelTask = Promise.reject(cause);
  }

  return Promise.allSettled([globalTask, totalsTask, modelTask]).then(([globalResult, , modelResult]) => {
    if (globalResult.status === 'rejected') throw persistFailure('upstream-global', globalResult.reason);
    if (modelResult.status === 'rejected') throw persistFailure('upstream-model', modelResult.reason, model);
  });
}
