// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// POLICIES_CONFIG: policy name -> { max_attempts, tier_attempts? }. Optional.
// `max_attempts` bounds total LOGICAL attempts per request across ALL tiers
// (default 5, valid range 1-8). `tier_attempts` optionally overrides the per-tier
// attempt budget (see handler.js computeTierCaps for the default distribution).
// Tier order is fixed (tier-1 -> tier-2 -> tier-3, hard precedence).
//
// Like the node config, POLICIES_CONFIG is strict: malformed JSON, unknown
// fields, invalid max_attempts, and invalid tier_attempts produce diagnostics
// instead of silently falling back to defaults. The parse is cached per isolate.

import { readEnv } from './env.js';

const DEFAULT_POLICY = { maxAttempts: 5 };
const MIN_ATTEMPTS = 1;
const MAX_ATTEMPTS = 8;
const TIER_KEYS = ['tier1', 'tier2', 'tier3'];
const ALLOWED_FIELDS = new Set(['max_attempts', 'tier_attempts']);

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
  const policies = {};
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      errors.push(`POLICIES_CONFIG invalid JSON (${e.message}); defaults used`);
      cached = { policies, errors };
      return cached;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('POLICIES_CONFIG must be a JSON object { name: { max_attempts, tier_attempts? } }');
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
        // max_attempts only participates when explicitly configured; a present
        // value (null included) must be an integer in [MIN_ATTEMPTS, MAX_ATTEMPTS].
        let attempts = DEFAULT_POLICY.maxAttempts;
        if (config.max_attempts !== undefined) {
          if (!Number.isInteger(config.max_attempts)
            || config.max_attempts < MIN_ATTEMPTS
            || config.max_attempts > MAX_ATTEMPTS) {
            errors.push(`POLICIES_CONFIG: "${name}": max_attempts must be an integer between ${MIN_ATTEMPTS} and ${MAX_ATTEMPTS}`);
          } else {
            attempts = config.max_attempts;
          }
        }
        policies[name.trim()] = {
          maxAttempts: attempts,
          tierAttempts,
        };
      }
    }
  }
  cached = { policies, errors };
  return cached;
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

export function getPolicy(modelName, modelsConfig, policiesConfig) {
  const policyName = modelsConfig[modelName]?.policy || 'default';
  return policiesConfig[policyName] || DEFAULT_POLICY;
}
