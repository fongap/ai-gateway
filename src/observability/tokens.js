// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Isolate-local token usage observability. PURE observability, NOT billing:
//
//   - Only usage REPORTED by the upstream is recorded (prompt/completion or
//     input/output aliases). Missing usage is counted as `missing` and is
//     NEVER estimated — tokens are never fabricated from characters/bytes.
//   - State lives in module-level memory and dies with the isolate. It is
//     best-effort, resets on isolate restart, and must not be relied on for
//     billing or per-key accounting.
//   - Zero imports: a leaf module so the stream layer (track.js) and the
//     dashboard (pages.js) can use it without cycles.

// Cardinality guard: models are registry-validated upstream of dispatch, so
// the natural cardinality is models × tiers × providers × nodes. Past the
// cap new buckets are dropped (totals stay exact, per-dimension rows become
// best-effort) so a pathological upstream cannot balloon isolate memory.
const MAX_BUCKETS = 512;
const MAX_DIMENSION_LENGTH = 80;

export const tokenStats = {
  startedAt: Date.now(),
  totals: { input: 0, output: 0, total: 0, reports: 0, missing: 0 },
  buckets: new Map(), // "<model>|<tier>|<provider>|<nodeId>" -> { model, tier, provider, nodeId, input, output, total, reports, missing }
};

function validTokenCount(value) {
  // Strict: numbers only (numeric strings from odd upstreams are rejected),
  // finite, non-negative. Fractional upstream values are truncated.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

// Normalize an upstream-reported usage object (OpenAI chat shape or the
// input_tokens/output_tokens aliases some providers emit) into
// { input, output, total }, or null when nothing usable was reported.
// This is the SINGLE reported-vs-missing gate: a reported-but-empty
// `usage: {}` normalizes to null and is therefore counted as missing.
//
// A field that was PROVIDED but holds an unusable value (non-number, NaN,
// negative, Infinity, empty string) makes the whole report unreliable: an
// upstream that emits garbage on one side cannot be trusted on the other, so
// nothing is recorded rather than a half-true number. Missing fields are the
// opposite case — partial data beats nothing (`{ prompt_tokens: 2 }` with no
// completion side is still a usable report).
export function normalizeTokenUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const inputKey = usage.prompt_tokens !== undefined ? 'prompt_tokens'
    : usage.input_tokens !== undefined ? 'input_tokens' : null;
  const outputKey = usage.completion_tokens !== undefined ? 'completion_tokens'
    : usage.output_tokens !== undefined ? 'output_tokens' : null;
  const inputRaw = inputKey === null ? undefined : usage[inputKey];
  const outputRaw = outputKey === null ? undefined : usage[outputKey];
  if ((inputKey !== null && validTokenCount(inputRaw) === null)
      || (outputKey !== null && validTokenCount(outputRaw) === null)) return null;
  const input = validTokenCount(inputRaw);
  const output = validTokenCount(outputRaw);
  if (input === null && output === null) return null; // neither side reported
  // A reported total_tokens wins verbatim even when it disagrees with
  // input+output: reported-first — the gateway never second-guesses upstream
  // numbers. A provided-but-invalid total is likewise untrustworthy.
  if (usage.total_tokens !== undefined && validTokenCount(usage.total_tokens) === null) return null;
  const reportedTotal = validTokenCount(usage.total_tokens);
  const total = reportedTotal ?? (input ?? 0) + (output ?? 0);
  return { input: input ?? 0, output: output ?? 0, total };
}

// Storage-time dimension sanitization: every value that can reach /metrics
// labels or dashboard HTML passes through one allowlist, so both surfaces are
// safe by construction. sanitizePrometheusLabel / escapeHtml remain as
// defense in depth.
function sanitizeDimension(value) {
  const raw = String(value ?? '');
  const cleaned = raw.replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, MAX_DIMENSION_LENGTH);
  return cleaned || 'unknown';
}

// Record one delivered response's usage. Exactly one of two outcomes per
// call: reports++ (plus token totals) or missing++. Never both, never
// neither. Callers pass the raw usage object (or null/undefined) — the
// reported-vs-missing decision lives here, not at the capture points.
// Missing records still land in their dimension bucket so per-dimension
// missing and coverage stay accurate, not just the isolate-wide totals.
export function recordTokenUsage({ model, tier, provider, nodeId, usage }) {
  const dims = {
    model: sanitizeDimension(model),
    tier: sanitizeDimension(tier),
    provider: sanitizeDimension(provider),
    nodeId: sanitizeDimension(nodeId),
  };
  const key = `${dims.model}|${dims.tier}|${dims.provider}|${dims.nodeId}`;
  const bucket = () => {
    let b = tokenStats.buckets.get(key);
    if (!b) {
      if (tokenStats.buckets.size >= MAX_BUCKETS) return null; // totals stay exact
      b = { ...dims, input: 0, output: 0, total: 0, reports: 0, missing: 0 };
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
  tokenStats.totals.total += normalized.total;
  const b = bucket();
  if (!b) return;
  b.reports += 1;
  b.input += normalized.input;
  b.output += normalized.output;
  b.total += normalized.total;
}

function aggregateBy(dimension) {
  const rows = new Map();
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

function usageCoverage() {
  const denominator = tokenStats.totals.reports + tokenStats.totals.missing;
  return denominator === 0 ? null : tokenStats.totals.reports / denominator;
}

// Isolate-global summary for /health and the dashboard's token panel.
export function summarizeTokenStats() {
  return {
    startedAt: tokenStats.startedAt,
    totals: { ...tokenStats.totals },
    usageCoverage: usageCoverage(),
    byModel: aggregateBy('model'),
    byProvider: aggregateBy('provider'),
    byTier: aggregateBy('tier'),
    byNode: aggregateBy('nodeId'),
  };
}

// Raw bucket rows (insertion order) for /metrics label series. Dimension
// rollups are a dashboard concern; Prometheus consumers aggregate themselves.
export function tokenMetricSeries() {
  return [...tokenStats.buckets.values()];
}

export function __resetTokenStatsForTests() {
  tokenStats.startedAt = Date.now();
  tokenStats.totals = { input: 0, output: 0, total: 0, reports: 0, missing: 0 };
  tokenStats.buckets = new Map();
}
