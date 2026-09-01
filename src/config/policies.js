// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// POLICIES_CONFIG: policy name -> { max_attempts, tier_attempts?, hedge? }. Optional.
// `max_attempts` bounds total LOGICAL attempts per request across ALL tiers
// (valid range 1-8). `tier_attempts` optionally overrides the per-tier
// attempt budget (see handler.js computeTierCaps for the default distribution).
// Tier order is fixed (tier-1 -> tier-2 -> tier-3, hard precedence).
//
// Built-in policies (always present, user config merges on top):
//   default        - balanced: maxAttempts=5, hedge=true (tier1+tier2; tier3 opt-in)
//   fast           - speed-first: maxAttempts=1, hedge=false
//   stable         - reliability: maxAttempts=5, hedge={enabled:true, tiers:['tier1']}
//   long-reasoning - extended first-event: maxAttempts=3, hedge=false, firstEventTimeoutMs=120000
//
// Like the node config, POLICIES_CONFIG is strict: malformed JSON, unknown
// fields, invalid max_attempts, and invalid tier_attempts produce diagnostics
// instead of silently falling back to defaults. The parse is cached per isolate.

import { readEnv } from './env.js';

const MIN_ATTEMPTS = 1;
const MAX_ATTEMPTS = 8;
const TIER_KEYS = ['tier1', 'tier2', 'tier3'];
const ALLOWED_FIELDS = new Set(['max_attempts', 'tier_attempts', 'hedge', 'first_event_timeout_ms']);

// Built-in policies — always present, user config merges on top.
// These are the single source of truth; no runtime fallback needed.
// All built-ins now explicitly declare hedge behavior (no undefined).
const BUILTIN_POLICIES = Object.freeze({
  default: {
    maxAttempts: 5,
    tierAttempts: null,
    hedge: { enabled: true },
    firstEventTimeoutMs: null,
  },
  fast: {
    maxAttempts: 1,
    tierAttempts: null,
    hedge: { enabled: false },
    firstEventTimeoutMs: null,
  },
  stable: {
    maxAttempts: 5,
    tierAttempts: null,
    hedge: { enabled: true, tiers: ['tier1'] },
    firstEventTimeoutMs: null,
  },
  'long-reasoning': {
    maxAttempts: 3,
    tierAttempts: null,
    hedge: { enabled: false },
    firstEventTimeoutMs: 120_000,
  },
});

let cachedEnv;
let cached;

export function loadPoliciesConfig(env) {
  return analyzePolicies(env).policies;
}

export function getPoliciesConfigDiagnostics(env) {
  return analyzePolicies(env).errors;
}

function analyzePolicies(env) {
  if (cachedEnv === env && cached) return cached;
  cachedEnv = env;
  const raw = readEnv(env, 'POLICIES_CONFIG');
  const errors = [];
  // Start with built-ins; user config merges on top (override).
  const policies = { ...BUILTIN_POLICIES };
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      errors.push(`POLICIES_CONFIG invalid JSON (${e.message}); built-ins used`);
      cached = { policies, errors };
      return cached;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('POLICIES_CONFIG must be a JSON object { name: { max_attempts, tier_attempts?, hedge? } }');
    } else {
      for (const [name, config] of Object.entries(parsed)) {
        if (!name.trim()) { errors.push('POLICIES_CONFIG: empty policy name (keys must be non-empty strings)'); continue; }
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
          errors.push(`POLICIES_CONFIG: "${name}" must be an object`);
          continue;
        }
        for (const field of Object.keys(config)) {
          if (!ALLOWED_FIELDS.has(field)) {
            errors.push(`POLICIES_CONFIG: "${name}" has unknown field "${field}" (allowed: ${[...ALLOWED_FIELDS].join(', ')})`);
          }
        }
        const tierAttempts = parseTierAttempts(config.tier_attempts, name, errors);
        const hedge = parseHedge(config.hedge, name, errors);
        const firstEventTimeoutMs = parseFirstEventTimeoutMs(config.first_event_timeout_ms, name, errors);
        let attempts;
        if (config.max_attempts !== undefined) {
          if (!Number.isInteger(config.max_attempts)
            || config.max_attempts < MIN_ATTEMPTS
            || config.max_attempts > MAX_ATTEMPTS) {
            errors.push(`POLICIES_CONFIG: "${name}": max_attempts must be an integer between ${MIN_ATTEMPTS} and ${MAX_ATTEMPTS}`);
            attempts = BUILTIN_POLICIES.default.maxAttempts;
          } else {
            attempts = config.max_attempts;
          }
        } else {
          attempts = BUILTIN_POLICIES.default.maxAttempts;
        }
        policies[name.trim()] = {
          maxAttempts: attempts,
          tierAttempts,
          hedge,
          firstEventTimeoutMs,
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
// When the field is absent entirely (user config omits hedge), null is returned
// and the handler falls back to the legacy global behavior (hedge enabled
// everywhere except tier3). Built-in policies always declare hedge explicitly.
function parseHedge(value, policyName, errors) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`POLICIES_CONFIG: "${policyName}": hedge must be an object { enabled?, delay_ms?, tiers? }`);
    return null;
  }
  const out = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') {
      errors.push(`POLICIES_CONFIG: "${policyName}": hedge.enabled must be a boolean`);
    } else {
      out.enabled = value.enabled;
    }
  }
  if (value.delay_ms !== undefined) {
    if (!Number.isInteger(value.delay_ms) || value.delay_ms < 0) {
      errors.push(`POLICIES_CONFIG: "${policyName}": hedge.delay_ms must be a non-negative integer`);
    } else {
      out.delayMs = value.delay_ms;
    }
  }
  if (value.tiers !== undefined) {
    if (!Array.isArray(value.tiers) || !value.tiers.every((t) => typeof t === 'string' && TIER_KEYS.includes(t))) {
      errors.push(`POLICIES_CONFIG: "${policyName}": hedge.tiers must be an array of "tier1", "tier2", "tier3"`);
    } else {
      out.tiers = value.tiers;
    }
  }
  return Object.keys(out).length ? out : null;
}

// Parse an optional per-tier attempt budget object: { tier1, tier2, tier3 }.
// Each value must be an integer in [0, MAX_ATTEMPTS]; 0 explicitly disables a
// tier. Non-integers (null included), out-of-range values and unknown keys
// produce diagnostics instead of being clamped or truncated.
function parseTierAttempts(value, policyName, errors) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`POLICIES_CONFIG: "${policyName}" tier_attempts must be an object { tier1, tier2, tier3 }`);
    return null;
  }
  const out = {};
  let any = false;
  for (const [key, val] of Object.entries(value)) {
    if (!TIER_KEYS.includes(key)) {
      errors.push(`POLICIES_CONFIG: "${policyName}" tier_attempts.${key} is not a valid tier (allowed: ${TIER_KEYS.join(', ')})`);
      continue;
    }
    if (!Number.isInteger(val) || val < 0 || val > MAX_ATTEMPTS) {
      errors.push(`POLICIES_CONFIG: "${policyName}" tier_attempts.${key} must be an integer between 0 and ${MAX_ATTEMPTS}`);
      continue;
    }
    out[key] = val;
    any = true;
  }
  return any ? out : null;
}

// Parse an optional first-event timeout override in milliseconds.
function parseFirstEventTimeoutMs(value, policyName, errors) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 5_000 || value > 600_000) {
    errors.push(`POLICIES_CONFIG: "${policyName}": first_event_timeout_ms must be an integer between 5000 and 600000`);
    return null;
  }
  return value;
}

export function getPolicy(modelName, modelsConfig, policiesConfig) {
  const policyName = modelsConfig[modelName]?.policy || 'default';
  return policiesConfig[policyName];
}
