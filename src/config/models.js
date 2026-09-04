// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// MODELS_CONFIG: logical model -> { policy, capabilities?, reasoning_efforts? }.
// This doubles as the Model Registry's config source. `policy` is the failover
// policy name; `capabilities` (tools / reasoning / vision / stream) and
// `reasoning_efforts` optionally override the registry defaults. Parsed once per
// isolate; env vars are immutable at runtime.
//
// Like the node config, MODELS_CONFIG is strict: unknown fields, an invalid
// `policy`, non-boolean capabilities, unknown capability keys, and malformed
// reasoning_efforts are surfaced as diagnostics (no silent guess at intent).
// The parse is done once
// per isolate and both the loaded config and its diagnostics are cached.

import { readEnv } from './env.js';

const CAPABILITY_KEYS = ['tools', 'reasoning', 'vision', 'stream', 'ocr'];
const ALLOWED_ENTRY_FIELDS = new Set(['policy', 'capabilities', 'reasoning_efforts', 'visibility', 'display_order', 'group', 'ui_visible']);
const VALID_VISIBILITY = new Set(['public', 'internal']);
const DEFAULT_VISIBILITY = 'public';
const DEFAULT_DISPLAY_ORDER = 100;
const DEFAULT_GROUP = 'general';
const DEFAULT_UI_VISIBLE = true;

let cachedEnv;
let cached;

export function loadModelsConfig(env) {
  return analyzeModels(env).models;
}

export function getModelsConfigDiagnostics(env) {
  return analyzeModels(env).errors;
}

function analyzeModels(env) {
  if (cachedEnv === env && cached) return cached;
  cachedEnv = env;
  const raw = readEnv(env, 'MODELS_CONFIG');
  const errors = [];
  const models = {};
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`MODELS_CONFIG invalid JSON (${msg}); fields ignored`);
      cached = { models, errors };
      return cached;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('MODELS_CONFIG must be a JSON object { model: { policy, capabilities, reasoning_efforts } }');
    } else {
      for (const [name, config] of Object.entries(parsed)) {
        if (!name.trim()) { errors.push('MODELS_CONFIG: empty model name (keys must be non-empty strings)'); continue; }
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
          errors.push(`MODELS_CONFIG: "${name}" must be an object`);
          continue;
        }
        for (const field of Object.keys(config)) {
          if (!ALLOWED_ENTRY_FIELDS.has(field)) {
            errors.push(`MODELS_CONFIG: "${name}" has unknown field "${field}" (allowed: ${[...ALLOWED_ENTRY_FIELDS].join(', ')})`);
          }
        }
        // `policy` participates only when explicitly configured; a present
        // value (null included) must be a non-empty string. Unknown policy
        // names are cross-checked against POLICIES_CONFIG by nodes.js.
        const entry = { policy: 'default', visibility: DEFAULT_VISIBILITY, ui_visible: DEFAULT_UI_VISIBLE };
        if (config.policy !== undefined) {
          if (typeof config.policy === 'string' && config.policy.trim()) {
            entry.policy = config.policy.trim();
          } else {
            errors.push(`MODELS_CONFIG: model "${name}": policy must be a non-empty string`);
          }
        }
        const vis = config.visibility;
        if (vis !== undefined) {
          if (!VALID_VISIBILITY.has(vis)) {
            errors.push(`MODELS_CONFIG: model "${name}": visibility must be "public" or "internal"`);
          } else {
            entry.visibility = vis;
          }
        }
        const order = config.display_order;
        if (order !== undefined) {
          if (typeof order !== 'number' || !Number.isFinite(order) || order < 0) {
            errors.push(`MODELS_CONFIG: model "${name}": display_order must be a non-negative finite number`);
          } else {
            entry.display_order = order;
          }
        } else {
          entry.display_order = DEFAULT_DISPLAY_ORDER;
        }
        const grp = config.group;
        if (grp !== undefined) {
          if (typeof grp !== 'string' || !grp.trim()) {
            errors.push(`MODELS_CONFIG: model "${name}": group must be a non-empty string`);
          } else {
            entry.group = grp.trim();
          }
        } else {
          entry.group = DEFAULT_GROUP;
        }
        const uiv = config.ui_visible;
        if (uiv !== undefined) {
          if (typeof uiv !== 'boolean') {
            errors.push(`MODELS_CONFIG: model "${name}": ui_visible must be a boolean`);
          } else {
            entry.ui_visible = uiv;
          }
        }
        const caps = config.capabilities;
        if (caps !== undefined) {
          if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
            errors.push(`MODELS_CONFIG: "${name}" capabilities must be an object`);
          } else {
            let hadValid = false;
            for (const [key, val] of Object.entries(caps)) {
              if (!CAPABILITY_KEYS.includes(key)) {
                errors.push(`MODELS_CONFIG: "${name}" capabilities.${key} is not a supported capability (allowed: ${CAPABILITY_KEYS.join(', ')})`);
              } else if (typeof val !== 'boolean') {
                errors.push(`MODELS_CONFIG: "${name}" capabilities.${key} must be a boolean`);
              } else {
                hadValid = true;
              }
            }
            if (hadValid) {
              entry.capabilities = Object.fromEntries(
                Object.entries(caps).filter(([k, v]) => CAPABILITY_KEYS.includes(k) && typeof v === 'boolean'),
              );
            }
          }
        }
        const efforts = config.reasoning_efforts;
        if (efforts !== undefined) {
          if (!Array.isArray(efforts) || !efforts.every((e) => typeof e === 'string' && e.trim())) {
            errors.push(`MODELS_CONFIG: "${name}" reasoning_efforts must be an array of non-empty strings`);
          } else {
            entry.reasoning_efforts = efforts.map((e) => e.trim());
          }
        }
        models[name.trim()] = entry;
      }
    }
  }
  cached = { models, errors };
  return cached;
}
