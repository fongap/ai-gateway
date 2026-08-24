// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// MODELS_CONFIG: logical model -> { policy }. Optional.
// Parsed once per isolate; env vars are immutable at runtime.

import { readEnv } from './env.js';

let cachedEnv;
let cachedModels;

export function loadModelsConfig(env) {
  if (cachedEnv === env && cachedModels) return cachedModels;
  cachedEnv = env;
  const raw = readEnv(env, 'MODELS_CONFIG');
  const models = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [name, config] of Object.entries(parsed)) {
          if (typeof name !== 'string' || !name.trim()) continue;
          models[name.trim()] = {
            policy: typeof config?.policy === 'string' && config.policy.trim() ? config.policy.trim() : 'default',
          };
        }
      }
    } catch {
      console.error('MODELS_CONFIG parse error: invalid JSON; ignoring');
    }
  }
  cachedModels = models;
  return models;
}
