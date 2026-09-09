// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Key-scoped gateway access.
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
//   * If no GATEWAY_ACCESS_KEY_<GROUP> is configured, no gateway credential
//     is accepted.
//
// Group identity is the only non-secret identifier in logs/stats.

import { readEnv } from './env.ts';
import { loadGatewayConfig } from './nodes.ts';
import { collectKnownModels } from './registry.ts';
import type { RuntimeNode } from '../types/node.ts';

export const KEY_GROUPS: readonly string[] = Object.freeze(['AIR', 'PRO', 'MAX', 'ULTRA', 'AGENT']);

// Parse a CSV model list. Whitespace around entries is trimmed; empty
// entries are dropped. A single "*" entry becomes allowAll=true. Returns
// { allowAll, allowlist, warnings, errors }.
function parseModelsField(raw: unknown, group: string, knownModels: ReadonlySet<string> | null): { allowAll: boolean, allowlist: Set<string>, warnings: string[], errors: string[] } {
  const out: { allowAll: boolean, allowlist: Set<string>, warnings: string[], errors: string[] } = { allowAll: false, allowlist: new Set(), warnings: [], errors: [] };
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
        out.warnings.push(`GATEWAY_ACCESS_MODELS_${group} references model "${m}" which is not in the Known Model Catalog (node models or MODELS_CONFIG)`);
      }
    }
  }
  return out;
}

// collectKnownModels and collectConfiguredModels are defined in registry.ts
// (the model-catalog module). They are re-exported here for callers that
// import them from this module.
export { collectKnownModels, collectConfiguredModels } from './registry.ts';

type AccessKeyEntry = { group: string, secret: string, allowAll: boolean, allowlist: Set<string> };
type AccessKeysAnalysis = {
  config: { keys: AccessKeyEntry[], diagnostics: string[] },
  keys: AccessKeyEntry[],
  diagnostics: string[],
};

let cachedEnv: Record<string, unknown> | null | undefined;
let cachedConfig: AccessKeysAnalysis | null | undefined;

export function loadAccessKeysConfig(env: Record<string, unknown>): { keys: AccessKeyEntry[], diagnostics: string[] } {
  return analyzeAccessKeys(env).config;
}

export function getAccessKeysDiagnostics(env: Record<string, unknown>): string[] {
  return analyzeAccessKeys(env).diagnostics;
}

function analyzeAccessKeys(env: Record<string, unknown>): AccessKeysAnalysis {
  if (cachedEnv === env && cachedConfig) return cachedConfig;
  cachedEnv = env;
  const diagnostics: string[] = [];
  const keys: AccessKeyEntry[] = [];
  // We need to know which logical models are currently configured to cross-check
  // the per-group allowlist. loadGatewayConfig is cached too, so this is cheap.
  let nodes: RuntimeNode[] = [];
  try {
    nodes = loadGatewayConfig(env).nodes || [];
  } catch {
    nodes = []; // config not yet loadable; cross-check skipped (warnings empty)
  }
  // The Known Model Catalog (node models keys union MODELS_CONFIG) is the
  // single source for the cross-check. A model in the allowlist but not in
  // the catalog emits a warning (the operator may add it later).
  const knownModels = collectKnownModels(nodes, env);

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

  cachedConfig = {
    config: { keys, diagnostics },
    keys,
    diagnostics,
  };
  return cachedConfig;
}

// Does a given model fall within a key's effective allowlist? This is the
// call used by the request handler — it must be paired with the live
// `configuredModels` set so that allowAll never grants a model that is
// not currently configured.
export function keyAllowsModel(keyEntry: { allowAll: boolean, allowlist: Set<string> } | null | undefined, model: string, configuredModels: ReadonlySet<string> | null | undefined): boolean {
  if (!keyEntry) return false;
  if (keyEntry.allowAll) {
    if (!configuredModels) return true; // permissive when no configuredModels given
    return configuredModels.has(model);
  }
  return keyEntry.allowlist.has(model);
}

// Filter the configured model set to the key's allowlist. This is what
// /v1/models returns. Visible == Callable by construction. Accepts the full
// AuthResult union: only authorized allowlist keys carry a concrete Set.
export function filterVisibleModels(keyEntry: { allowAll?: boolean, allowlist?: ReadonlySet<string> } | null | undefined, configuredModels: ReadonlySet<string> | null | undefined): string[] {
  if (!configuredModels) return [];
  if (keyEntry?.allowAll) return [...configuredModels].sort();
  if (!keyEntry || !keyEntry.allowlist) return [];
  return [...configuredModels].filter((m) => keyEntry.allowlist?.has(m) === true).sort();
}

// Snapshot for diagnostics consumers.
export function __resetAccessKeysCacheForTests(): void {
  cachedEnv = null;
  cachedConfig = null;
}
