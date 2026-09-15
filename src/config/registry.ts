// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Model Registry — single source of truth for logical-model policy and
// capabilities. Runtime Nodes own only logical -> upstream mappings.

import { loadModelsConfig } from './models.ts';

const DEFAULT_CAPABILITIES = Object.freeze({ tools: false, reasoning: false, vision: false, stream: true, ocr: false });
const DEFAULT_REASONING_EFFORTS: readonly string[] = Object.freeze([]);
const DEFAULT_POLICY = 'default';
const DEFAULT_VISIBILITY = 'public';
const DEFAULT_DISPLAY_ORDER = 100;
const DEFAULT_GROUP = 'general';
const DEFAULT_UI_VISIBLE = true;

export type RegistryEntry = {
  policy: string,
  visibility: string,
  capabilities: Record<string, boolean>,
  reasoning_efforts: string[],
  modalities?: { input: string[], output: string[] },
  display_order: number,
  group: string,
  ui_visible: boolean,
};

let cachedEnv: Record<string, unknown> | undefined;
let cachedRegistry: Record<string, RegistryEntry> | undefined;

export function loadModelRegistry(env: Record<string, unknown>): Record<string, RegistryEntry> {
  if (cachedEnv === env && cachedRegistry) return cachedRegistry;
  cachedEnv = env;
  const models = loadModelsConfig(env);
  const registry: Record<string, RegistryEntry> = {};
  for (const [name, cfg] of Object.entries(models)) {
    registry[name] = {
      policy: cfg.policy || DEFAULT_POLICY,
      visibility: cfg.visibility || DEFAULT_VISIBILITY,
      capabilities: { ...DEFAULT_CAPABILITIES, ...(cfg.capabilities || {}) },
      reasoning_efforts: Array.isArray(cfg.reasoning_efforts) && cfg.reasoning_efforts.length
        ? cfg.reasoning_efforts
        : [...DEFAULT_REASONING_EFFORTS],
      ...(cfg.modalities ? { modalities: cfg.modalities } : {}),
      display_order: cfg.display_order !== undefined ? cfg.display_order : DEFAULT_DISPLAY_ORDER,
      group: cfg.group !== undefined ? cfg.group : DEFAULT_GROUP,
      ui_visible: cfg.ui_visible !== undefined ? cfg.ui_visible : DEFAULT_UI_VISIBLE,
    };
  }
  cachedRegistry = registry;
  return registry;
}

export function modelRegistryEntry(env: Record<string, unknown>, model: string): RegistryEntry {
  const registry = loadModelRegistry(env);
  return registry[model] || {
    policy: DEFAULT_POLICY,
    visibility: DEFAULT_VISIBILITY,
    capabilities: { ...DEFAULT_CAPABILITIES },
    reasoning_efforts: [...DEFAULT_REASONING_EFFORTS],
    display_order: DEFAULT_DISPLAY_ORDER,
    group: DEFAULT_GROUP,
    ui_visible: DEFAULT_UI_VISIBLE,
  };
}

export function listRegistryModels(env: Record<string, unknown>): string[] {
  return Object.keys(loadModelRegistry(env)).sort();
}

export function isWildcardNode(node: { models: Record<string, string> }): boolean {
  return Object.keys(node.models).length === 0;
}

// Empty `models:{}` is an intentional wildcard ONLY inside the known logical
// model catalog. Without that catalog, wildcard routing fails closed; callers
// no longer receive an old permissive fallback.
export function servesModel(
  node: { models: Record<string, string> },
  model: string,
  knownModels?: ReadonlySet<string> | null,
): boolean {
  if (isWildcardNode(node)) return !!knownModels?.has(model);
  return Object.hasOwn(node.models, model);
}

// One canonical Known Model Catalog: explicit node mappings + MODELS_CONFIG.
export function collectKnownModels(
  nodes?: ReadonlyArray<{ models?: Record<string, string> } | null | undefined>,
  env?: Record<string, unknown>,
): Set<string> {
  const set = new Set<string>();
  for (const n of nodes || []) {
    for (const k of Object.keys(n?.models || {})) set.add(k);
  }
  if (env) {
    try {
      const models = loadModelsConfig(env);
      for (const name of Object.keys(models)) set.add(name);
    } catch { /* config diagnostics own malformed MODELS_CONFIG */ }
  }
  return set;
}
