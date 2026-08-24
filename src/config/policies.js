// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// POLICIES_CONFIG: policy name -> { max_attempts }. Optional.
// Tier order is fixed (tier-1 -> tier-2 -> tier-3, hard precedence) and is
// intentionally NOT configurable: a lower tier may only be used when the
// current tier has no eligible node left for this request.

import { readEnv } from './env.js';

const DEFAULT_POLICY = { maxAttempts: 5 };
const MIN_ATTEMPTS = 1;
const MAX_ATTEMPTS = 8;

let cachedEnv;
let cachedPolicies;

export function loadPoliciesConfig(env) {
  if (cachedEnv === env && cachedPolicies) return cachedPolicies;
  cachedEnv = env;
  const policies = {};
  const raw = readEnv(env, 'POLICIES_CONFIG');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [name, config] of Object.entries(parsed)) {
          if (typeof name !== 'string' || !name.trim()) continue;
          const attempts = Number(config?.max_attempts);
          policies[name.trim()] = {
            maxAttempts: Number.isFinite(attempts)
              ? Math.max(MIN_ATTEMPTS, Math.min(MAX_ATTEMPTS, Math.trunc(attempts)))
              : DEFAULT_POLICY.maxAttempts,
          };
        }
      }
    } catch {
      console.error('POLICIES_CONFIG parse error: invalid JSON; ignoring');
    }
  }
  cachedPolicies = policies;
  return policies;
}

export function getPolicy(modelName, modelsConfig, policiesConfig) {
  const policyName = modelsConfig[modelName]?.policy || 'default';
  return policiesConfig[policyName] || DEFAULT_POLICY;
}
