// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// MODELS_CONFIG: logical model -> { policy, capabilities?, reasoning_efforts? }.
// This doubles as the Model Registry's config source. `policy` is the failover
// policy name; `capabilities` (tools / reasoning / vision / stream) and
// `reasoning_efforts` optionally override the registry defaults. All fields are
// optional. Parsed once per isolate; env vars are immutable at runtime.

import { readEnv } from './env.js';

const CAPABILITY_KEYS = ['tools', 'reasoning', 'vision', 'stream'];

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
          const entry = {
            policy: typeof config?.policy === 'string' && config.policy.trim() ? config.policy.trim() : 'default',
          };
          const caps = config?.capabilities;
          if (caps && typeof caps === 'object' && !Array.isArray(caps)) {
            const valid = CAPABILITY_KEYS.filter((k) => typeof caps[k] === 'boolean');
            if (valid.length) entry.capabilities = Object.fromEntries(valid.map((k) => [k, caps[k]]));
          }
          const efforts = config?.reasoning_efforts;
          if (Array.isArray(efforts) && efforts.every((e) => typeof e === 'string' && e.trim())) {
            entry.reasoning_efforts = efforts.map((e) => e.trim());
          }
          models[name.trim()] = entry;
        }
      }
    } catch {
      console.error('MODELS_CONFIG parse error: invalid JSON; ignoring');
    }
  }
  cachedModels = models;
  return models;
}
