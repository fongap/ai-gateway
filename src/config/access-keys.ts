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
//   * "*" alone grants every currently-known logical model.
//   * Access Models referencing a model that is NOT currently known emit a
//     diagnostic warning. The referenced model is NOT auto-created.
//   * If no GATEWAY_ACCESS_KEY_<GROUP> is configured, no gateway credential
//     is accepted.

import { readEnv } from './env.ts';
import { loadGatewayConfig } from './nodes.ts';
import { collectKnownModels } from './registry.ts';
import type { RuntimeNode } from '../types/node.ts';

export const KEY_GROUPS: readonly string[] = Object.freeze(['AIR', 'PRO', 'MAX', 'ULTRA', 'AGENT']);

function parseModelsField(raw: unknown, group: string, knownModels: ReadonlySet<string> | null): { allowAll: boolean, allowlist: Set<string>, warnings: string[], errors: string[] } {
  const out: { allowAll: boolean, allowlist: Set<string>, warnings: string[], errors: string[] } = { allowAll: false, allowlist: new Set(), warnings: [], errors: [] };
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== 'string') {
    out.errors.push(`GATEWAY_ACCESS_MODELS_${group} must be a CSV string ("Model1,Model2" or "*")`);
    return out;
  }
  const trimmed = raw.trim();
  if (!trimmed) return out;
  if (trimmed === '*') {
    out.allowAll = true;
    return out;
  }
  for (const p of trimmed.split(',').map((s) => s.trim()).filter(Boolean)) out.allowlist.add(p);
  if (knownModels) {
    for (const m of out.allowlist) {
      if (!knownModels.has(m)) {
        out.warnings.push(`GATEWAY_ACCESS_MODELS_${group} references model "${m}" which is not in the Known Model Catalog (node models or MODELS_CONFIG)`);
      }
    }
  }
  return out;
}

// Keep one catalog owner. Callers that need catalog construction import it from
// registry.ts directly rather than through compatibility re-exports.
export { collectKnownModels } from './registry.ts';

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
  let nodes: RuntimeNode[] = [];
  try {
    nodes = loadGatewayConfig(env).nodes || [];
  } catch {
    nodes = [];
  }
  const knownModels = collectKnownModels(nodes, env);

  for (const group of KEY_GROUPS) {
    const secret = readEnv(env, `GATEWAY_ACCESS_KEY_${group}`);
    if (!secret) continue;
    const parsed = parseModelsField(env ? env[`GATEWAY_ACCESS_MODELS_${group}`] : undefined, group, knownModels);
    diagnostics.push(...parsed.warnings, ...parsed.errors);
    keys.push({ group, secret: String(secret), allowAll: parsed.allowAll, allowlist: parsed.allowlist });
  }

  cachedConfig = { config: { keys, diagnostics }, keys, diagnostics };
  return cachedConfig;
}

export function keyAllowsModel(keyEntry: { allowAll: boolean, allowlist: Set<string> } | null | undefined, model: string, configuredModels: ReadonlySet<string> | null | undefined): boolean {
  if (!keyEntry) return false;
  if (keyEntry.allowAll) {
    if (!configuredModels) return true;
    return configuredModels.has(model);
  }
  return keyEntry.allowlist.has(model);
}

export function filterVisibleModels(keyEntry: { allowAll?: boolean, allowlist?: ReadonlySet<string> } | null | undefined, configuredModels: ReadonlySet<string> | null | undefined): string[] {
  if (!configuredModels) return [];
  if (keyEntry?.allowAll) return [...configuredModels].sort();
  if (!keyEntry?.allowlist) return [];
  return [...configuredModels].filter((m) => keyEntry.allowlist?.has(m) === true).sort();
}

export function __resetAccessKeysCacheForTests(): void {
  cachedEnv = null;
  cachedConfig = null;
}
