// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Isolate-local token-usage normalization and observability. NOT billing:
//
//   - Only usage REPORTED by the upstream is recorded (prompt/completion or
//     input/output aliases). Missing usage is counted as `missing` and is
//     NEVER estimated — tokens are never fabricated from characters/bytes.
//   - State lives in module-level memory and dies with the isolate. It is
//     best-effort, resets on isolate restart, and must not be relied on for
//     billing or per-key accounting. This keeps the gateway on the free
//     Cloudflare tier: no KV/D1/Durable-Object bindings on the hot path.
//   - Two rolling time windows — hourly buckets over the last 24h and daily
//     buckets over the last 7d — are the same isolate-local best-effort
//     contract. They reset with the isolate and are never persisted. This
//     module feeds /metrics and /health; the PUBLIC homepage reads the durable
//     D1 aggregate (token-usage-store.ts) instead, so the panel is no longer
//     isolate-scoped.
//   - Zero imports: a leaf module so the stream layer (track.ts) and the
//     dashboard (pages.ts) can use it without cycles.
//
// Cardinality guard: models are registry-validated upstream of dispatch, so
// the natural cardinality is models × tiers × providers × nodes. Past the
// cap new buckets are dropped (totals stay exact, per-dimension rows become
// best-effort) so a pathological upstream cannot balloon isolate memory.
const MAX_BUCKETS = 512;
const MAX_DIMENSION_LENGTH = 80;

// Rolling time windows — isolate-local, so they reset with the isolate and
// need no bindings. Hour buckets keep the last 24 (≈近 24 小时); day buckets
// keep the last 7 (≈近 7 天). Pruning on every successful record keeps the
// two Maps bounded to at most 24 + 7 entries, well inside free-tier memory.
const HOUR_MS = 3600_000;
const DAY_MS = 86400_000;
const HOURS_24 = 24;
const DAYS_7 = 7;

// Supported upstream usage fields (Anthropic + OpenAI + Responses).
// Providers may emit partial reports; we merge by FIELD (not by addition).
// Anthropic streaming: message_start has input tokens, message_delta has output tokens.
// Anthropic cache: cache_creation_input_tokens, cache_read_input_tokens are separate fields.
// OpenAI: prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details.cached_tokens.
// Cached tokens in OpenAI are already PART of prompt_tokens — do NOT add again.
// Anthropic cache tokens are ADDITIONAL to input_tokens — they represent extra input activity.
export type NormalizedTokenUsage = {
  input: number,              // ordinary input tokens (prompt_tokens / input_tokens)
  output: number,             // output tokens (completion_tokens / output_tokens)
  cacheCreation: number,      // cache_creation_input_tokens (Anthropic only)
  cacheRead: number,          // cache_read_input_tokens (Anthropic only)
  effectiveInput: number,     // input + cacheCreation + cacheRead (total input activity)
  total: number,              // effectiveInput + output
};

export type TokenUsageBucket = {
  model: string,
  tier: string,
  provider: string,
  nodeId: string,
  input: number,
  output: number,
  cacheCreation: number,
  cacheRead: number,
  effectiveInput: number,
  total: number,
  reports: number,
  missing: number,
};

export type RollingWindowBucket = { total: number, reports: number };

export const tokenStats: {
  startedAt: number,
  totals: { input: number, output: number, cacheCreation: number, cacheRead: number, effectiveInput: number, total: number, reports: number, missing: number },
  buckets: Map<string, TokenUsageBucket>, // "<model>|<tier>|<provider>|<nodeId>" -> bucket
  hourBuckets: Map<number, RollingWindowBucket>, // hourStartMs -> { total, reports }  (rolling 24h)
  dayBuckets: Map<number, RollingWindowBucket>, // dayStartMs  -> { total, reports }  (rolling 7d)
} = {
  startedAt: Date.now(),
  totals: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, effectiveInput: 0, total: 0, reports: 0, missing: 0 },
  buckets: new Map(),
  hourBuckets: new Map(),
  dayBuckets: new Map(),
};

function validTokenCount(value: unknown): number | null {
  // Strict: numbers only (numeric strings from odd upstreams are rejected),
  // finite, non-negative. Fractional upstream values are truncated.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

// Merge two upstream-reported usage objects by FIELD (not by addition).
// Anthropic streaming reports are CUMULATIVE: message_delta.usage.output_tokens
// is the running total. message_start.usage.input_tokens is the running total.
// message_delta may also re-report input_tokens (cumulative).
// OpenAI final chunk usage is also cumulative.
// Therefore: next field value REPLACES previous if next has the field;
// if next lacks a field, keep previous.
// This is "last-field-wins per field", not "last-object-wins" and not "sum".
export function mergeReportedUsage(previous: unknown, next: unknown): unknown {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return previous;
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return next;
  const prev = previous as Record<string, unknown>;
  const nxt = next as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...prev };
  // All known usage fields: next's field value wins if present and valid.
  // We copy ALL fields from next that are valid numbers; unknown fields pass through.
  for (const key of Object.keys(nxt)) {
    const val = nxt[key];
    const valid = validTokenCount(val);
    if (valid !== null) {
      merged[key] = valid;
    } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      // Nested objects (e.g., prompt_tokens_details) - merge recursively
      merged[key] = mergeReportedUsage(prev[key], val);
    }
    // Non-numeric non-object fields are ignored (not usable for token counting)
  }
  return merged;
}

// Normalize an upstream-reported usage object (OpenAI chat shape, Responses,
// or Anthropic input_tokens/output_tokens) into NormalizedTokenUsage,
// or null when nothing usable was reported.
// This is the SINGLE reported-vs-missing gate: a reported-but-empty
// `usage: {}` normalizes to null and is therefore counted as missing.
//
// A field that was PROVIDED but holds an unusable value (non-number, NaN,
// negative, Infinity, empty string) makes the whole report unreliable: an
// upstream that emits garbage on one side cannot be trusted on the other, so
// nothing is recorded rather than a half-true number. Missing fields are the
// opposite case — partial data beats nothing (`{ prompt_tokens: 2 }` with no
// completion side is still a usable report).
export function normalizeTokenUsage(usage: unknown): NormalizedTokenUsage | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const u = usage as Record<string, unknown>;

  // Anthropic input tokens (ordinary + cache)
  const inputRaw = u.input_tokens ?? u.prompt_tokens;
  const cacheCreationRaw = u.cache_creation_input_tokens;
  const cacheReadRaw = u.cache_read_input_tokens;
  const outputRaw = u.output_tokens ?? u.completion_tokens;

  // Validate all provided fields. If ANY provided field is invalid, reject entire report.
  if (inputRaw !== undefined && validTokenCount(inputRaw) === null) return null;
  if (cacheCreationRaw !== undefined && validTokenCount(cacheCreationRaw) === null) return null;
  if (cacheReadRaw !== undefined && validTokenCount(cacheReadRaw) === null) return null;
  if (outputRaw !== undefined && validTokenCount(outputRaw) === null) return null;

  const input = validTokenCount(inputRaw) ?? 0;
  const cacheCreation = validTokenCount(cacheCreationRaw) ?? 0;
  const cacheRead = validTokenCount(cacheReadRaw) ?? 0;
  const output = validTokenCount(outputRaw) ?? 0;

  // If nothing usable was reported at all, return null (counts as missing)
  if (inputRaw === undefined && cacheCreationRaw === undefined && cacheReadRaw === undefined && outputRaw === undefined) {
    return null;
  }

  // total_tokens: if provided and valid, use verbatim (reported-first).
  // Otherwise compute: effectiveInput + output.
  let total: number;
  if (u.total_tokens !== undefined) {
    const reportedTotal = validTokenCount(u.total_tokens);
    if (reportedTotal === null) return null;
    total = reportedTotal;
  } else {
    total = input + cacheCreation + cacheRead + output;
  }

  const effectiveInput = input + cacheCreation + cacheRead;
  return { input, output, cacheCreation, cacheRead, effectiveInput, total };
}

// Storage-time dimension sanitization: every value that can reach /metrics
// labels or dashboard HTML passes through one allowlist, so both surfaces are
// safe by construction. sanitizePrometheusLabel / escapeHtml remain as
// defense in depth.
function sanitizeDimension(value: unknown): string {
  const raw = String(value ?? '');
  const cleaned = raw.replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, MAX_DIMENSION_LENGTH);
  return cleaned || 'unknown';
}

// Bump one rolling time window: align `now` down to the unit boundary, prune
// every bucket older than the window (current + keep-1 prior stay), then add
// the report. The Maps stay bounded to `keep` entries. Deleting the current
// entry mid-iteration of a Map is spec-safe.
function bumpWindow(map: Map<number, RollingWindowBucket>, now: number, unitMs: number, keep: number, total: number): void {
  const start = Math.floor(now / unitMs) * unitMs;
  const cutoff = start - (keep - 1) * unitMs;
  for (const ts of map.keys()) {
    if (ts < cutoff) map.delete(ts);
  }
  let b = map.get(start);
  if (!b) {
    b = { total: 0, reports: 0 };
    map.set(start, b);
  }
  b.total += total;
  b.reports += 1;
}

// Sum every surviving bucket in a rolling window. The dashboard shows the
// rolling total; reports are exposed too so the window can be audited.
function sumWindow(map: Map<number, RollingWindowBucket>): { total: number, reports: number } {
  let total = 0;
  let reports = 0;
  for (const b of map.values()) {
    total += b.total;
    reports += b.reports;
  }
  return { total, reports };
}

// Record one delivered response's usage. Exactly one of two outcomes per
// call: reports++ (plus token totals) or missing++. Never both, never
// neither. Callers pass the raw usage object (or null/undefined) — the
// reported-vs-missing decision lives here, not at the capture points.
// Missing records still land in their dimension bucket so per-dimension
// missing and coverage stay accurate, not just the isolate-wide totals.
// The rolling time windows only advance on a real report — a missing-usage
// response carries no tokens to attribute to any hour/day.
export function recordTokenUsage({ model, tier, provider, nodeId, usage, now = Date.now() }: {
  model: unknown,
  tier: unknown,
  provider: unknown,
  nodeId: unknown,
  usage: unknown,
  now?: number,
}): void {
  const dims = {
    model: sanitizeDimension(model),
    tier: sanitizeDimension(tier),
    provider: sanitizeDimension(provider),
    nodeId: sanitizeDimension(nodeId),
  };
  const key = `${dims.model}|${dims.tier}|${dims.provider}|${dims.nodeId}`;
  const bucket = (): TokenUsageBucket | null => {
    let b = tokenStats.buckets.get(key);
    if (!b) {
      if (tokenStats.buckets.size >= MAX_BUCKETS) return null; // totals stay exact
      b = { ...dims, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, effectiveInput: 0, total: 0, reports: 0, missing: 0 };
      tokenStats.buckets.set(key, b);
    }
    return b;
  };
  const normalized = normalizeTokenUsage(usage);
  if (!normalized) {
    tokenStats.totals.missing += 1;
    const b = bucket();
    if (b) b.missing += 1;
    return;
  }
  tokenStats.totals.reports += 1;
  tokenStats.totals.input += normalized.input;
  tokenStats.totals.output += normalized.output;
  tokenStats.totals.cacheCreation += normalized.cacheCreation;
  tokenStats.totals.cacheRead += normalized.cacheRead;
  tokenStats.totals.effectiveInput += normalized.effectiveInput;
  tokenStats.totals.total += normalized.total;
  bumpWindow(tokenStats.hourBuckets, now, HOUR_MS, HOURS_24, normalized.total);
  bumpWindow(tokenStats.dayBuckets, now, DAY_MS, DAYS_7, normalized.total);
  const b = bucket();
  if (!b) return;
  b.reports += 1;
  b.input += normalized.input;
  b.output += normalized.output;
  b.cacheCreation += normalized.cacheCreation;
  b.cacheRead += normalized.cacheRead;
  b.effectiveInput += normalized.effectiveInput;
  b.total += normalized.total;
}

type DimensionName = 'model' | 'provider' | 'tier' | 'nodeId';
type DimensionRow = { name: string, input: number, output: number, total: number, reports: number, missing: number };

function aggregateBy(dimension: DimensionName): DimensionRow[] {
  const rows = new Map<string, DimensionRow>();
  for (const bucket of tokenStats.buckets.values()) {
    const name = bucket[dimension];
    let row = rows.get(name);
    if (!row) {
      row = { name, input: 0, output: 0, total: 0, reports: 0, missing: 0 };
      rows.set(name, row);
    }
    row.input += bucket.input;
    row.output += bucket.output;
    row.total += bucket.total;
    row.reports += bucket.reports;
    row.missing += bucket.missing;
  }
  // Total-desc so the dashboard's Top-N is just "take the first rows" and the
  // ordering itself stays unit-testable here rather than in the HTML layer.
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

function usageCoverage(): number | null {
  const denominator = tokenStats.totals.reports + tokenStats.totals.missing;
  return denominator === 0 ? null : tokenStats.totals.reports / denominator;
}

// Isolate-global summary for /health, /metrics and diagnostics.
export function summarizeTokenStats() {
  return {
    startedAt: tokenStats.startedAt,
    totals: { ...tokenStats.totals },
    usageCoverage: usageCoverage(),
    windows: {
      h24: sumWindow(tokenStats.hourBuckets),
      d7: sumWindow(tokenStats.dayBuckets),
    },
    byModel: aggregateBy('model'),
    byProvider: aggregateBy('provider'),
    byTier: aggregateBy('tier'),
    byNode: aggregateBy('nodeId'),
  };
}

// Raw bucket rows (insertion order) for /metrics label series. Dimension
// rollups are a dashboard concern; Prometheus consumers aggregate themselves.
export function tokenMetricSeries(): TokenUsageBucket[] {
  return [...tokenStats.buckets.values()];
}

export function __resetTokenStatsForTests(): void {
  tokenStats.startedAt = Date.now();
  tokenStats.totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, effectiveInput: 0, total: 0, reports: 0, missing: 0 };
  tokenStats.buckets = new Map();
  tokenStats.hourBuckets = new Map();
  tokenStats.dayBuckets = new Map();
}
