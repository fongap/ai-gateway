// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// POLICIES_CONFIG: policy name -> { max_attempts, tier_attempts?, hedge? }. Optional.
// `max_attempts` bounds total LOGICAL attempts per request across ALL tiers
// (valid range 1-8). `tier_attempts` optionally overrides the per-tier
// attempt budget (see tier-loop.ts computeTierCaps for the distribution rules).
// Tier order is fixed (tier-1 -> tier-2 -> tier-3, hard precedence).
//
// Built-in policies (always present, user config merges on top):
//   default        - balanced: maxAttempts=5, hedge enabled for Tier 1 only
//   fast           - speed-first: maxAttempts=1, hedge disabled
//   stable         - reliability: maxAttempts=5, hedge enabled for Tier 1 only
//   long-reasoning - extended first-event: maxAttempts=3, hedge disabled, firstEventTimeoutMs=120000
//
// Hedging is controlled per policy: hedge.enabled must be true for hedging to
// activate. default and stable enable hedge for the tiers listed in
// hedge.tiers (currently ['tier1']); fast and long-reasoning disable it.
// Custom policies may specify any subset of tier1/tier2/tier3 via
// hedge.tiers; tiers not listed never launch hedge twins.
//
// Like the node config, POLICIES_CONFIG is strict: malformed JSON, unknown
// fields, invalid max_attempts, and invalid tier_attempts produce diagnostics
// instead of silently falling back to defaults. The parse is cached per isolate.

import { readEnv } from './env.ts';
import type { PolicyConfig } from '../types/policy.ts';

const MIN_ATTEMPTS = 1;
const MAX_ATTEMPTS = 8;
const TIER_KEYS = ['tier1', 'tier2', 'tier3'];
const ALLOWED_FIELDS = new Set(['max_attempts', 'tier_attempts', 'hedge', 'first_event_timeout_ms', 'budget_split']);

type HedgePolicy = { enabled?: boolean, delayMs?: number, tiers?: Array<'tier1' | 'tier2' | 'tier3'> } | null;
type TierAttempts = { tier1?: number, tier2?: number, tier3?: number } | null;

// Built-in policies — always present, user config merges on top.
// These are the single source of truth; no runtime fallback needed.
// All built-ins now explicitly declare hedge behavior (no undefined).
// default and stable enable hedging for Tier 1 only; fast and long-reasoning disable it.
const BUILTIN_POLICIES: Record<string, PolicyConfig> = Object.freeze({
  default: {
    maxAttempts: 5,
    tierAttempts: null,
    hedge: { enabled: true, tiers: ['tier1'] },
    firstEventTimeoutMs: null,
    budgetSplit: null,
  },
  fast: {
    maxAttempts: 1,
    tierAttempts: null,
    hedge: { enabled: false },
    firstEventTimeoutMs: null,
    budgetSplit: null,
  },
  stable: {
    maxAttempts: 5,
    tierAttempts: null,
    hedge: { enabled: true, tiers: ['tier1'] },
    firstEventTimeoutMs: null,
    budgetSplit: null,    
  },
  'long-reasoning': {
    maxAttempts: 3,
    tierAttempts: null,
    hedge: { enabled: false },
    firstEventTimeoutMs: 120_000,
    budgetSplit: null,
  },
});

let cachedEnv: Record<string, unknown> | undefined;
let cached: { policies: Record<string, PolicyConfig>, errors: string[] } | undefined;

export function loadPoliciesConfig(env: Record<string, unknown>): Record<string, PolicyConfig> {
  return analyzePolicies(env).policies;
}

export function getPoliciesConfigDiagnostics(env: Record<string, unknown>): string[] {
  return analyzePolicies(env).errors;
}

function analyzePolicies(env: Record<string, unknown>): { policies: Record<string, PolicyConfig>, errors: string[] } {
  if (cachedEnv === env && cached) return cached;
  cachedEnv = env;
  const raw = readEnv(env, 'POLICIES_CONFIG');
  const errors: string[] = [];
  // Start with built-ins; user config merges on top (override) — partial override:
  // explicitly declared fields override; absent fields inherit from the built-in
  // (or null for custom names).
  const policies: Record<string, PolicyConfig> = { ...BUILTIN_POLICIES };
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`POLICIES_CONFIG invalid JSON (${msg}); built-ins used`);
      cached = { policies, errors };
      return cached;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('POLICIES_CONFIG must be a JSON object { name: { max_attempts, tier_attempts?, hedge? } }');
    } else {
      for (const [name, config] of Object.entries(parsed as Record<string, unknown>)) {
        if (!name.trim()) { errors.push('POLICIES_CONFIG: empty policy name (keys must be non-empty strings)'); continue; }
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
          errors.push(`POLICIES_CONFIG: "${name}" must be an object`);
          continue;
        }
        const cfg = config as Record<string, unknown>;
        for (const field of Object.keys(cfg)) {
          if (!ALLOWED_FIELDS.has(field)) {
            errors.push(`POLICIES_CONFIG: "${name}" has unknown field "${field}" (allowed: ${[...ALLOWED_FIELDS].join(', ')})`);
          }
        }
        const key = name.trim();
        const base = policies[key];
        const tierErrorsBefore = errors.length;
        const tierAttempts = cfg.tier_attempts === undefined ? (base?.tierAttempts ?? null) : parseTierAttempts(cfg.tier_attempts, key, errors);
        const tierAttemptsValid = errors.length === tierErrorsBefore;
        const hedge = cfg.hedge === undefined ? (base?.hedge ?? null) : parseHedge(cfg.hedge, key, errors);
        const firstEventTimeoutMs = cfg.first_event_timeout_ms === undefined ? (base?.firstEventTimeoutMs ?? null) : parseFirstEventTimeoutMs(cfg.first_event_timeout_ms, key, errors);
        const budgetSplit = cfg.budget_split === undefined ? (base?.budgetSplit ?? null) : parseBudgetSplit(cfg.budget_split, key, errors);
        let attempts: number;
        let maxAttemptsValid = true;
        if (cfg.max_attempts !== undefined) {
          const rawMax = cfg.max_attempts;
          if (typeof rawMax !== 'number'
            || !Number.isInteger(rawMax)
            || rawMax < MIN_ATTEMPTS
            || rawMax > MAX_ATTEMPTS) {
            errors.push(`POLICIES_CONFIG: "${key}": max_attempts must be an integer between ${MIN_ATTEMPTS} and ${MAX_ATTEMPTS}`);
            attempts = base?.maxAttempts ?? BUILTIN_POLICIES.default.maxAttempts;
            maxAttemptsValid = false;
          } else {
            attempts = rawMax;
          }
        } else {
          attempts = base?.maxAttempts ?? BUILTIN_POLICIES.default.maxAttempts;
        }
        if (tierAttempts && tierAttemptsValid && maxAttemptsValid) {
          const tierAttemptsTotal = Object.values(tierAttempts).reduce((sum, value) => sum + (value ?? 0), 0);
          if (tierAttemptsTotal > attempts) {
            errors.push(`POLICIES_CONFIG: "${key}": tier_attempts total exceeds max_attempts (${tierAttemptsTotal} > ${attempts})`);
          }
        }
        policies[key] = {
          maxAttempts: attempts,
          tierAttempts,
          hedge,
          firstEventTimeoutMs,
          budgetSplit,
        };
      }
    }
  }
  cached = { policies, errors };
  return cached;
}

// Parse an optional hedge policy: { enabled?, delay_ms?, tiers? }.
//   enabled   — boolean (default true); false disables hedging for this policy.
//   delay_ms  — integer >= 0; overrides HEDGE_DELAY_MS for this policy.
//   tiers     — array of "tier1"/"tier2"/"tier3"; if present, only those
//               tiers may launch hedge twins. Absent = all tiers.
// When the field is absent entirely (user config omits hedge), null is returned.
// null means "no hedge for this policy". Built-in policies always declare hedge
// explicitly. Custom policies without an explicit hedge have no hedge.
function parseHedge(value: unknown, policyName: string, errors: string[]): HedgePolicy {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`POLICIES_CONFIG: "${policyName}": hedge must be an object { enabled?, delay_ms?, tiers? }`);
    return null;
  }
  const rec = value as Record<string, unknown>;
  const out: { enabled?: boolean, delayMs?: number, tiers?: Array<'tier1' | 'tier2' | 'tier3'> } = {};
  if (rec.enabled !== undefined) {
    if (typeof rec.enabled !== 'boolean') {
      errors.push(`POLICIES_CONFIG: "${policyName}": hedge.enabled must be a boolean`);
    } else {
      out.enabled = rec.enabled;
    }
  }
  if (rec.delay_ms !== undefined) {
    // `typeof` leads the guard for the same narrowing/rejection reason as
    // max_attempts above.
    if (typeof rec.delay_ms !== 'number' || !Number.isInteger(rec.delay_ms) || rec.delay_ms < 0) {
      errors.push(`POLICIES_CONFIG: "${policyName}": hedge.delay_ms must be a non-negative integer`);
    } else {
      out.delayMs = rec.delay_ms;
    }
  }
  if (rec.tiers !== undefined) {
    if (!Array.isArray(rec.tiers) || !rec.tiers.every((t) => typeof t === 'string' && TIER_KEYS.includes(t))) {
      errors.push(`POLICIES_CONFIG: "${policyName}": hedge.tiers must be an array of "tier1", "tier2", "tier3"`);
    } else {
      out.tiers = rec.tiers;
    }
  }
  return Object.keys(out).length ? out : null;
}

// Parse an optional per-tier attempt budget object: { tier1, tier2, tier3 }.
// Each value must be an integer in [0, MAX_ATTEMPTS]; 0 explicitly disables a
// tier. Non-integers (null included), out-of-range values and unknown keys
// produce diagnostics instead of being clamped or truncated.
function parseTierAttempts(value: unknown, policyName: string, errors: string[]): TierAttempts {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`POLICIES_CONFIG: "${policyName}" tier_attempts must be an object { tier1, tier2, tier3 }`);
    return null;
  }
  const out: { tier1?: number, tier2?: number, tier3?: number } = {};
  let any = false;
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (!TIER_KEYS.includes(key)) {
      errors.push(`POLICIES_CONFIG: "${policyName}" tier_attempts.${key} is not a valid tier (allowed: ${TIER_KEYS.join(', ')})`);
      continue;
    }
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 0 || val > MAX_ATTEMPTS) {
      errors.push(`POLICIES_CONFIG: "${policyName}" tier_attempts.${key} must be an integer between 0 and ${MAX_ATTEMPTS}`);
      continue;
    }
    out[key as 'tier1' | 'tier2' | 'tier3'] = val;
    any = true;
  }
  return any ? out : null;
}

// Parse an optional first-event timeout override in milliseconds.
function parseFirstEventTimeoutMs(value: unknown, policyName: string, errors: string[]): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 5_000 || value > 600_000) {
    errors.push(`POLICIES_CONFIG: "${policyName}": first_event_timeout_ms must be an integer between 5000 and 600000`);
    return null;
  }
  return value;
}

// Parse an optional budget_split strategy.
//   "even"     (default, backward-compatible): first dispatchable tier gets
//              the entire surplus.
//   "weighted": surplus is distributed proportionally to each tier's live
//              dispatchable node count.
function parseBudgetSplit(value: unknown, policyName: string, errors: string[]): 'even' | 'weighted' | null {
  if (value === undefined || value === null) return null;
  if (value === 'even' || value === 'weighted') return value;
  errors.push(`POLICIES_CONFIG: "${policyName}": budget_split must be "even" or "weighted"`);
  return null;
}

export function getPolicy(modelName: string, modelsConfig: Record<string, { policy?: string }>, policiesConfig: Record<string, PolicyConfig>): PolicyConfig {
  const policyName = modelsConfig[modelName]?.policy || 'default';
  return policiesConfig[policyName];
}
