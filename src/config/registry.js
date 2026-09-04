// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Model Registry — the single source of truth for logical-model policy and
// capabilities.
//
// Responsibility split (kept out of this module):
//   Node / Scheduler   = logical model -> upstream model, which node to use,
//                        whether the node is usable right now.
//   Transport (src/transport) = how to talk to the upstream (path, headers, stream semantics).
//   Model Registry     = what a logical model CAN do (policy + capabilities).
//
// The registry is fed from MODELS_CONFIG (logical model -> { policy,
// capabilities?, reasoning_efforts? }). A model without explicit capabilities /
// reasoning_efforts gets conservative defaults. Provider quirks are NEVER used
// as the model-capability truth: a provider only describes transport/protocol,
// not what every model under it does.

import { loadModelsConfig } from './models.js';

// Under-report capabilities, never over-report: an unlisted model is assumed to
// support nothing beyond streaming. Only an explicit MODELS_CONFIG declaration
// turns a capability on. This keeps /v1/models from promising tools/reasoning
// for third-party OpenAI-compatible models that may not have them.
const DEFAULT_CAPABILITIES = Object.freeze({ tools: false, reasoning: false, vision: false, stream: true, ocr: false });
const DEFAULT_REASONING_EFFORTS = Object.freeze([]);
const DEFAULT_POLICY = 'default';
const DEFAULT_VISIBILITY = 'public';
const DEFAULT_DISPLAY_ORDER = 100;
const DEFAULT_GROUP = 'general';
const DEFAULT_UI_VISIBLE = true;

let cachedEnv;
let cachedRegistry;

// Build the authoritative registry object: { logicalModel: { policy,
// capabilities, reasoning_efforts, visibility } }.
export function loadModelRegistry(env) {
  if (cachedEnv === env && cachedRegistry) return cachedRegistry;
  cachedEnv = env;
  const models = loadModelsConfig(env);
  const registry = {};
  for (const [name, cfg] of Object.entries(models)) {
    registry[name] = {
      policy: cfg.policy || DEFAULT_POLICY,
      visibility: cfg.visibility || DEFAULT_VISIBILITY,
      capabilities: { ...DEFAULT_CAPABILITIES, ...(cfg.capabilities || {}) },
      reasoning_efforts: Array.isArray(cfg.reasoning_efforts) && cfg.reasoning_efforts.length
        ? cfg.reasoning_efforts
        : [...DEFAULT_REASONING_EFFORTS],
      display_order: cfg.display_order !== undefined ? cfg.display_order : DEFAULT_DISPLAY_ORDER,
      group: cfg.group !== undefined ? cfg.group : DEFAULT_GROUP,
      ui_visible: cfg.ui_visible !== undefined ? cfg.ui_visible : DEFAULT_UI_VISIBLE,
    };
  }
  cachedRegistry = registry;
  return registry;
}

// Resolve the registry entry for a logical model, filling conservative defaults
// for models not declared in the registry (so /v1/models never has to guess
// capability from a provider quirk).
export function modelRegistryEntry(env, model) {
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

export function listRegistryModels(env) {
  return Object.keys(loadModelRegistry(env)).sort();
}

export function isWildcardNode(node) {
  return !node.models || Object.keys(node.models).length === 0;
}

// Does this node serve the given logical model?
//   * A node with an explicit `models` map serves only the models it declares.
//   * A wildcard node (empty `models`) serves ANY model inside the current
//     Known Model Catalog. With no catalog supplied (standalone tests that
//     build raw nodes without an env), the legacy permissive behavior is
//     preserved — the request path always passes the catalog, so the
//     gateway itself is always closed.
export function servesModel(node, model, knownModels) {
  if (isWildcardNode(node)) return knownModels ? knownModels.has(model) : true;
  return Object.hasOwn(node.models, model);
}

// Collect the Known Model Catalog for a node list + env: the union of every
// explicit node `models` key and every MODELS_CONFIG key. This is the single
// source of truth for "which logical models exist" used by authorization,
// wildcard eligibility, /v1/models, diagnostics, health, metrics, the model
// status projection and the scheduler. No other module should reassemble its
// own model set.
export function collectKnownModels(nodes, env) {
  const set = new Set();
  for (const n of nodes || []) {
    for (const k of Object.keys(n?.models || {})) set.add(k);
  }
  if (env) {
    try {
      const models = loadModelsConfig(env);
      for (const name of Object.keys(models)) set.add(name);
    } catch { /* MODELS_CONFIG not loadable */ }
  }
  return set;
}

// Build the list of explicitly-configured logical models from a node list.
// Wildcard nodes (empty `models`) do NOT contribute names. This is a subset
// of collectKnownModels and is kept for backward compatibility with callers
// that need only the node-mapped set.
export function collectConfiguredModels(nodes) {
  const set = new Set();
  for (const n of nodes || []) {
    for (const k of Object.keys(n?.models || {})) set.add(k);
  }
  return set;
}
