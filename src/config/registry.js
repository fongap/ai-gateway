// SPDX-License-Identifier: MIT
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
const DEFAULT_CAPABILITIES = Object.freeze({ tools: false, reasoning: false, vision: false, stream: true });
const DEFAULT_REASONING_EFFORTS = Object.freeze([]);
const DEFAULT_POLICY = 'default';
const DEFAULT_VISIBILITY = 'public';

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
  };
}

export function listRegistryModels(env) {
  return Object.keys(loadModelRegistry(env)).sort();
}

export function isWildcardNode(node) {
  return !node.models || Object.keys(node.models).length === 0;
}

// Does this node serve the given logical model? A wildcard node serves any
// model; a mapped node serves only models it declares.
export function servesModel(node, model) {
  if (isWildcardNode(node)) return true;
  return Object.hasOwn(node.models, model);
}
