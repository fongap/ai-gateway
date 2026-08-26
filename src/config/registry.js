// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Model Registry — the single source of truth for logical-model policy and
// capabilities.
//
// Responsibility split (kept out of this module):
//   Node / Scheduler   = logical model -> upstream model, which node to use,
//                        whether the node is usable right now.
//   Provider / Profile = how to talk to the upstream (transport protocol).
//   Model Registry     = what a logical model CAN do (policy + capabilities).
//
// The registry is fed from MODELS_CONFIG (logical model -> { policy,
// capabilities?, reasoning_efforts? }). A model without explicit capabilities /
// reasoning_efforts gets conservative defaults. Provider profiles are NEVER used
// as the model-capability truth: a provider only describes transport/protocol,
// not what every model under it does.

import { loadModelsConfig } from './models.js';

const DEFAULT_CAPABILITIES = Object.freeze({ tools: true, reasoning: true, vision: false, stream: true });
const DEFAULT_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high']);
const DEFAULT_POLICY = 'default';

let cachedEnv;
let cachedRegistry;

// Build the authoritative registry object: { logicalModel: { policy,
// capabilities, reasoning_efforts } }.
export function loadModelRegistry(env) {
  if (cachedEnv === env && cachedRegistry) return cachedRegistry;
  cachedEnv = env;
  const models = loadModelsConfig(env);
  const registry = {};
  for (const [name, cfg] of Object.entries(models)) {
    registry[name] = {
      policy: cfg.policy || DEFAULT_POLICY,
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
// capability from a provider profile).
export function modelRegistryEntry(env, model) {
  const registry = loadModelRegistry(env);
  return registry[model] || {
    policy: DEFAULT_POLICY,
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
