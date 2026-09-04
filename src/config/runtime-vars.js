// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Single source of truth for every non-sensitive runtime variable the
// gateway recognizes. The deployment bridge (github-deployment-config.mjs)
// derives its allowlist from this registry; the timeout loader
// (timeouts.js) derives its clamp limits from the int entries; docs and
// example configs reference the same names.
//
// Sensitive values (GATEWAY_ACCESS_KEY, TIER*_NODES_SECRETS_*, CLOUDFLARE_API_TOKEN)
// are NOT listed here — they are Secrets, never plain Worker variables.
//
// CLOUDFLARE_ACCOUNT_ID, TOKEN_STATS_D1_ID and GATEWAY_PUBLIC_BASE_URL are
// deployment identifiers, not runtime tunables; the bridge handles them
// separately via REQUIRED_VARS / REQUIRED_SECRETS.

export const RUNTIME_TUNABLES = [
  { name: 'UPSTREAM_HEADERS_TIMEOUT_MS', type: 'int', min: 5_000, max: 600_000, def: 15_000 },
  { name: 'FIRST_EVENT_TIMEOUT_MS', type: 'int', min: 5_000, max: 600_000, def: 30_000 },
  { name: 'STREAM_IDLE_TIMEOUT_MS', type: 'int', min: 10_000, max: 600_000, def: 120_000 },
  { name: 'RATE_LIMIT_COOLDOWN_MS', type: 'int', min: 1_000, max: 600_000, def: 30_000 },
  { name: 'AUTH_FAIL_COOLDOWN_MS', type: 'int', min: 60_000, max: 7 * 86_400_000, def: 3_600_000 },
  { name: 'MAX_BODY_BYTES', type: 'int', min: 1024, max: 100 * 1024 * 1024, def: 20 * 1024 * 1024 },
  { name: 'FAILOVER_BUDGET_MS', type: 'int', min: 1_000, max: 900_000, def: 60_000 },
  { name: 'HEDGE_DELAY_MS', type: 'int', min: 0, max: 600_000, def: 3_000 },
  { name: 'MAX_HEDGES_PER_REQUEST', type: 'int', min: 0, max: 3, def: 1 },
];

export const RUNTIME_STRING_VARS = [
  { name: 'ALLOWED_ORIGIN', def: '' },
  { name: 'STREAM_INCLUDE_USAGE', def: 'auto' },
  { name: 'STREAM_USAGE_INCLUDE_OFF_PROVIDERS', def: '' },
  { name: 'ANTHROPIC_COUNT_TOKENS_MODE', def: 'approximate' },
  { name: 'LOG_LEVEL', def: 'info' },
  { name: 'PROTOCOL_FALLBACKS', def: '' },
];

export const RUNTIME_BOOL_VARS = [
  { name: 'EXPOSE_UPSTREAM_INFO', def: false },
  { name: 'FAKE_STREAM_PROTECTION', def: false },
  { name: 'ALLOW_INSECURE_HTTP_UPSTREAM', def: false },
];

// Every non-sensitive runtime variable name, for the deployment bridge.
export const RUNTIME_VAR_NAMES = [
  ...RUNTIME_TUNABLES.map((v) => v.name),
  ...RUNTIME_STRING_VARS.map((v) => v.name),
  ...RUNTIME_BOOL_VARS.map((v) => v.name),
];
