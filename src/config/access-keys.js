// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Key-scoped gateway access. v1.2.7 governance model.
//
// Five independent credential groups — AIR, PRO, MAX, ULTRA, AGENT — each
// with its own secret and model allowlist:
//
//   GATEWAY_ACCESS_KEY_<GROUP>      = <secret>
//   GATEWAY_ACCESS_MODELS_<GROUP>   = "Model1,Model2"   (CSV; "*" = all)
//
// Rules:
//   * Each group is independent. No inheritance, no implicit defaults.
//   * Allowlist semantics are fail-closed: a missing or empty
//     GATEWAY_ACCESS_MODELS_<GROUP> grants ZERO models.
//   * "*" alone grants every currently-configured logical model
//     (intersection with the union of node `models` keys).
//   * `Access Models` referencing a model that is NOT currently
//     configured in any TIER*_NODES_CONFIG_*.models emits a diagnostic
//     warning. The referenced model is NOT auto-created.
//   * If ANY new GATEWAY_ACCESS_KEY_<GROUP> is configured, the legacy
//     GATEWAY_ACCESS_KEY is NOT consulted — a misconfigured new Key
//     never silently widens to a legacy full-access key.
//   * The legacy GATEWAY_ACCESS_KEY only works when no new key group
//     is configured (and grants all currently-configured models).
//
// Group identity is the only non-secret identifier in logs/stats.

import { readEnv } from './env.js';
import { loadGatewayConfig } from './nodes.js';
import { loadModelsConfig } from './models.js';

export const KEY_GROUPS = Object.freeze(['AIR', 'PRO', 'MAX', 'ULTRA', 'AGENT']);

// Parse a CSV model list. Whitespace around entries is trimmed; empty
// entries are dropped. A single "*" entry becomes allowAll=true. Returns
// { allowAll, allowlist, warnings, errors }.
function parseModelsField(raw, group, knownModels) {
  const out = { allowAll: false, allowlist: new Set(), warnings: [], errors: [] };
  if (raw === undefined || raw === null) return out; // missing -> empty allowlist (fail closed)
  if (typeof raw !== 'string') {
    out.errors.push(`GATEWAY_ACCESS_MODELS_${group} must be a CSV string ("Model1,Model2" or "*")`);
    return out;
  }
  const trimmed = raw.trim();
  if (!trimmed) return out; // empty string -> empty allowlist (fail closed)
  if (trimmed === '*') {
    out.allowAll = true;
    return out;
  }
  const parts = trimmed.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const p of parts) out.allowlist.add(p);
  // Cross-check: every name in the allowlist should resolve to a configured
  // logical model. Unknown names are warnings, not errors — the operator may
  // be declaring a model that will be added in a later deployment. We do NOT
  // create the model; we merely report it.
  if (knownModels) {
    for (const m of out.allowlist) {
      if (!knownModels.has(m)) {
        out.warnings.push(`GATEWAY_ACCESS_MODELS_${group} references model "${m}" which is not currently configured in any TIER*_NODES_CONFIG_*.models`);
      }
    }
  }
  return out;
}

// Build the list of currently-configured logical models from a node list.
// Wildcard nodes (empty `models`) do NOT contribute names — wildcard is a
// per-node service contract, not a model declaration.
export function collectConfiguredModels(nodes) {
  const set = new Set();
  for (const n of nodes || []) {
    for (const k of Object.keys(n?.models || {})) set.add(k);
  }
  return set;
}

// Build the closed catalog of all known logical models.
// Includes both explicitly mapped models and models declared in MODELS_CONFIG.
// This is the authoritative list of models that wildcard nodes can serve.
export function collectKnownModels(nodes, env) {
  const set = new Set();
  // Explicit node mappings
  for (const n of nodes || []) {
    for (const k of Object.keys(n?.models || {})) set.add(k);
  }
  // Models declared in MODELS_CONFIG (even if no node serves them yet)
  if (env) {
    try {
      const models = loadModelsConfig(env);
      for (const name of Object.keys(models)) set.add(name);
    } catch { /* MODELS_CONFIG not loadable */ }
  }
  return set;
}

let cachedEnv;
let cachedConfig;

export function loadAccessKeysConfig(env) {
  return analyzeAccessKeys(env).config;
}

export function getAccessKeysDiagnostics(env) {
  return analyzeAccessKeys(env).diagnostics;
}

function analyzeAccessKeys(env) {
  if (cachedEnv === env && cachedConfig) return cachedConfig;
  cachedEnv = env;
  const diagnostics = [];
  const keys = [];
  // We need to know which logical models are currently configured to cross-check
  // the per-group allowlist. loadGatewayConfig is cached too, so this is cheap.
  let nodes = [];
  try {
    nodes = loadGatewayConfig(env).nodes || [];
  } catch {
    nodes = []; // config not yet loadable; cross-check skipped (warnings empty)
  }
  const knownModels = collectConfiguredModels(nodes);

  // Detect whether any new-style GATEWAY_ACCESS_KEY_<GROUP> is configured.
  // This decides whether the legacy GATEWAY_ACCESS_KEY is consulted.
  let anyNewKey = false;
  for (const group of KEY_GROUPS) {
    if (readEnv(env, `GATEWAY_ACCESS_KEY_${group}`)) { anyNewKey = true; break; }
  }

  for (const group of KEY_GROUPS) {
    const secret = readEnv(env, `GATEWAY_ACCESS_KEY_${group}`);
    if (!secret) continue; // group not configured -> skip
    const modelsFieldRaw = env ? env[`GATEWAY_ACCESS_MODELS_${group}`] : undefined;
    const parsed = parseModelsField(modelsFieldRaw, group, knownModels);
    for (const w of parsed.warnings) diagnostics.push(w);
    for (const e of parsed.errors) diagnostics.push(e);
    keys.push({
      group,
      secret: String(secret),
      allowAll: parsed.allowAll,
      allowlist: parsed.allowlist,
    });
  }

  // Legacy single-key path. Only honored when NO new GATEWAY_ACCESS_KEY_<GROUP>
  // is configured. A misconfigured new key group never falls back to this.
  if (!anyNewKey) {
    const legacy = readEnv(env, 'GATEWAY_ACCESS_KEY');
    if (legacy) {
      keys.push({ group: 'LEGACY', secret: String(legacy), allowAll: true, allowlist: new Set() });
    }
  }

  cachedConfig = {
    config: { keys, diagnostics, anyNewKey },
    keys,
    diagnostics,
    anyNewKey,
  };
  return cachedConfig;
}

// Does a given model fall within a key's effective allowlist? This is the
// call used by the request handler — it must be paired with the live
// `configuredModels` set so that allowAll never grants a model that is
// not currently configured.
export function keyAllowsModel(keyEntry, model, configuredModels) {
  if (!keyEntry) return false;
  if (keyEntry.allowAll) {
    if (!configuredModels) return true; // permissive when no configuredModels given
    return configuredModels.has(model);
  }
  return keyEntry.allowlist.has(model);
}

// Filter the configured model set to the key's allowlist. This is what
// /v1/models returns. Visible == Callable by construction.
export function filterVisibleModels(keyEntry, configuredModels) {
  if (!configuredModels) return [];
  if (keyEntry?.allowAll) return [...configuredModels].sort();
  if (!keyEntry) return [];
  return [...configuredModels].filter((m) => keyEntry.allowlist.has(m)).sort();
}

// Snapshot for diagnostics consumers.
export function __resetAccessKeysCacheForTests() {
  cachedEnv = null;
  cachedConfig = null;
}
