// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// ACCESS_KEYS_CONFIG — multi-key API access with per-key model allowlists.
//
// Governance (v1.2.6):
//   * Fail closed: `models: null` or missing does NOT mean "allow all".
//     An explicit `models: ["*"]` is required to grant full access.
//   * New models must not implicitly widen an existing key's permission.
//   * `key_id` is the only non-secret identifier used in logs/stats.
//   * Deleting a key entry and redeploying immediately revokes access.
//
// When ACCESS_KEYS_CONFIG is absent the gateway falls back to the legacy
// single GATEWAY_ACCESS_KEY (full access, backward compatible).
//
// Note: per-key allowlists are checked against the model's identity only.
// MODELS_CONFIG is OPTIONAL and is used here purely as an advisory cross-check
// — operators without MODELS_CONFIG can still use ACCESS_KEYS_CONFIG and the
// allowlist is enforced against whatever model the request names.

import { readEnv } from './env.js';
import { loadModelRegistry } from './registry.js';

let cachedEnv;
let cachedConfig;

// Parse ACCESS_KEYS_CONFIG. Returns { keys: [{ key_id, secret, models }], diagnostics: [] }.
export function loadAccessKeysConfig(env) {
  return analyzeAccessKeys(env).config;
}

export function getAccessKeysDiagnostics(env) {
  return analyzeAccessKeys(env).diagnostics;
}

function analyzeAccessKeys(env) {
  if (cachedEnv === env && cachedConfig) return cachedConfig;
  cachedEnv = env;
  const raw = readEnv(env, 'ACCESS_KEYS_CONFIG');
  const diagnostics = [];
  const keys = [];

  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      diagnostics.push(`ACCESS_KEYS_CONFIG invalid JSON (${e.message}); no keys loaded`);
      cachedConfig = { config: { keys: [], diagnostics }, keys, diagnostics };
      return cachedConfig;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      diagnostics.push('ACCESS_KEYS_CONFIG must be a JSON object { keys: [...] }');
    } else {
      const list = Array.isArray(parsed.keys) ? parsed.keys : [];
      if (!Array.isArray(parsed.keys)) {
        diagnostics.push('ACCESS_KEYS_CONFIG: "keys" must be an array');
      }
      const seenIds = new Set();
      const registry = safeRegistry(env);
      for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          diagnostics.push(`ACCESS_KEYS_CONFIG: key #${i} must be an object`);
          continue;
        }
        const keyId = typeof entry.key_id === 'string' ? entry.key_id.trim() : '';
        if (!keyId) {
          diagnostics.push(`ACCESS_KEYS_CONFIG: key #${i} missing non-empty "key_id"`);
        } else if (seenIds.has(keyId)) {
          diagnostics.push(`ACCESS_KEYS_CONFIG: duplicate key_id "${keyId}"`);
        }
        seenIds.add(keyId);

        const secret = typeof entry.secret === 'string' ? entry.secret : '';
        if (!secret) {
          diagnostics.push(`ACCESS_KEYS_CONFIG: key "${keyId || `#${i}`}" missing "secret"`);
        }

        // Allowlist resolution: missing/null/undefined → empty (fail closed).
        // "*" means all models.
        let allowAll = false;
        const allowlist = new Set();
        const modelsField = entry.models;
        if (modelsField !== undefined && modelsField !== null) {
          if (!Array.isArray(modelsField)) {
            diagnostics.push(`ACCESS_KEYS_CONFIG: key "${keyId}" "models" must be an array or ["*"]`);
          } else if (modelsField.length === 1 && modelsField[0] === '*') {
            allowAll = true;
          } else {
            for (const m of modelsField) {
              if (typeof m !== 'string' || !m.trim()) {
                diagnostics.push(`ACCESS_KEYS_CONFIG: key "${keyId}" has a non-string model entry`);
                continue;
              }
              allowlist.add(m.trim());
              // MODELS_CONFIG is optional. The allowlist is enforced on
              // request, not at config time — a model not declared in the
              // registry is still a perfectly valid allowlist entry; the
              // request will simply not match any node and the handler will
              // return 404, exactly as for any other unknown model. Skip the
              // "not in registry" advisory entirely when registry is empty.
              if (registry && Object.keys(registry).length > 0 && !Object.prototype.hasOwnProperty.call(registry, m.trim())) {
                diagnostics.push(`ACCESS_KEYS_CONFIG: key "${keyId}" allowlists model "${m}" which is not in the Model Registry`);
              }
            }
          }
        }

        keys.push({ key_id: keyId || `key-${i}`, secret, allowAll, allowlist });
      }
    }
  }

  cachedConfig = {
    config: { keys, diagnostics },
    keys,
    diagnostics,
  };
  return cachedConfig;
}

function safeRegistry(env) {
  try {
    return loadModelRegistry(env);
  } catch {
    return null;
  }
}

// Does a given model fall within a key's allowlist? Fail closed when the
// allowlist is empty (not ["*"]).
export function keyAllowsModel(keyEntry, model) {
  if (!keyEntry) return false;
  if (keyEntry.allowAll) return true;
  return keyEntry.allowlist.has(model);
}

// Snapshot for diagnostics consumers.
export function __resetAccessKeysCacheForTests() {
  cachedEnv = null;
  cachedConfig = null;
}
