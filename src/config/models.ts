// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// MODELS_CONFIG: logical model -> { policy, capabilities?, reasoning_efforts?,
// modalities? }.
// This doubles as the Model Registry's config source. `policy` is the failover
// policy name; `capabilities` (tools / reasoning / vision / stream) and
// `reasoning_efforts` optionally override the registry defaults. `modalities`
// is a SCHEMA RESERVATION for the Omni phase (what a model can accept/emit:
// input/output token arrays over a closed vocabulary); it is parsed, validated
// and carried in the registry, but nothing routes on it yet and it is NOT
// exposed on any public API surface. Parsed once per
// isolate; env vars are immutable at runtime.
//
// Like the node config, MODELS_CONFIG is strict: unknown fields, an invalid
// `policy`, non-boolean capabilities, unknown capability keys, and malformed
// reasoning_efforts are surfaced as diagnostics (no silent guess at intent).
// The parse is done once
// per isolate and both the loaded config and its diagnostics are cached.

import { readEnv } from './env.ts';

const CAPABILITY_KEYS = ['tools', 'reasoning', 'vision', 'stream', 'ocr'];
const ALLOWED_ENTRY_FIELDS = new Set(['policy', 'capabilities', 'reasoning_efforts', 'modalities', 'visibility', 'display_order', 'group', 'ui_visible']);
// Closed modality vocabulary for the Omni-phase schema reservation. Extending
// this list is the ONLY way to introduce a new modality token — free-form
// strings never enter the registry.
const MODALITY_TOKENS = new Set(['text', 'image', 'audio', 'video']);
const VALID_VISIBILITY = new Set(['public', 'internal']);
const DEFAULT_VISIBILITY = 'public';
const DEFAULT_DISPLAY_ORDER = 100;
const DEFAULT_GROUP = 'general';
const DEFAULT_UI_VISIBLE = true;

/**
 * A parsed MODELS_CONFIG entry. Optional fields are only present when
 * explicitly configured (or defaulted) by the parse below.
 */
export type ModelEntry = {
  policy: string,
  visibility: string,
  ui_visible: boolean,
  display_order: number,
  group: string,
  capabilities?: Record<string, boolean>,
  reasoning_efforts?: string[],
  modalities?: { input: string[], output: string[] },
};

let cachedEnv: Record<string, unknown> | undefined;
let cached: { models: Record<string, ModelEntry>, errors: string[] } | undefined;

export function loadModelsConfig(env: Record<string, unknown>): Record<string, ModelEntry> {
  return analyzeModels(env).models;
}

export function getModelsConfigDiagnostics(env: Record<string, unknown>): string[] {
  return analyzeModels(env).errors;
}

function analyzeModels(env: Record<string, unknown>): { models: Record<string, ModelEntry>, errors: string[] } {
  if (cachedEnv === env && cached) return cached;
  cachedEnv = env;
  const raw = readEnv(env, 'MODELS_CONFIG');
  const errors: string[] = [];
  const models: Record<string, ModelEntry> = {};
  if (raw) {
    let parsed: unknown;
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
      for (const [name, config] of Object.entries(parsed as Record<string, unknown>)) {
        if (!name.trim()) { errors.push('MODELS_CONFIG: empty model name (keys must be non-empty strings)'); continue; }
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
          errors.push(`MODELS_CONFIG: "${name}" must be an object`);
          continue;
        }
        const cfg = config as Record<string, unknown>;
        for (const field of Object.keys(cfg)) {
          if (!ALLOWED_ENTRY_FIELDS.has(field)) {
            errors.push(`MODELS_CONFIG: "${name}" has unknown field "${field}" (allowed: ${[...ALLOWED_ENTRY_FIELDS].join(', ')})`);
          }
        }
        // `policy` participates only when explicitly configured; a present
        // value (null included) must be a non-empty string. Unknown policy
        // names are cross-checked against POLICIES_CONFIG by nodes.ts.
        const entry: ModelEntry = { policy: 'default', visibility: DEFAULT_VISIBILITY, ui_visible: DEFAULT_UI_VISIBLE, display_order: DEFAULT_DISPLAY_ORDER, group: DEFAULT_GROUP };
        if (cfg.policy !== undefined) {
          if (typeof cfg.policy === 'string' && cfg.policy.trim()) {
            entry.policy = cfg.policy.trim();
          } else {
            errors.push(`MODELS_CONFIG: model "${name}": policy must be a non-empty string`);
          }
        }
        const vis = cfg.visibility;
        if (vis !== undefined) {
          if (typeof vis !== 'string' || !VALID_VISIBILITY.has(vis)) {
            errors.push(`MODELS_CONFIG: model "${name}": visibility must be "public" or "internal"`);
          } else {
            entry.visibility = vis;
          }
        }
        const order = cfg.display_order;
        if (order !== undefined) {
          if (typeof order !== 'number' || !Number.isFinite(order) || order < 0) {
            errors.push(`MODELS_CONFIG: model "${name}": display_order must be a non-negative finite number`);
          } else {
            entry.display_order = order;
          }
        } else {
          entry.display_order = DEFAULT_DISPLAY_ORDER;
        }
        const grp = cfg.group;
        if (grp !== undefined) {
          if (typeof grp !== 'string' || !grp.trim()) {
            errors.push(`MODELS_CONFIG: model "${name}": group must be a non-empty string`);
          } else {
            entry.group = grp.trim();
          }
        } else {
          entry.group = DEFAULT_GROUP;
        }
        const uiv = cfg.ui_visible;
        if (uiv !== undefined) {
          if (typeof uiv !== 'boolean') {
            errors.push(`MODELS_CONFIG: model "${name}": ui_visible must be a boolean`);
          } else {
            entry.ui_visible = uiv;
          }
        }
        const caps = cfg.capabilities;
        if (caps !== undefined) {
          if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
            errors.push(`MODELS_CONFIG: "${name}" capabilities must be an object`);
          } else {
            const capRec = caps as Record<string, unknown>;
            let hadValid = false;
            for (const [key, val] of Object.entries(capRec)) {
              if (!CAPABILITY_KEYS.includes(key)) {
                errors.push(`MODELS_CONFIG: "${name}" capabilities.${key} is not a supported capability (allowed: ${CAPABILITY_KEYS.join(', ')})`);
              } else if (typeof val !== 'boolean') {
                errors.push(`MODELS_CONFIG: "${name}" capabilities.${key} must be a boolean`);
              } else {
                hadValid = true;
              }
            }
            if (hadValid) {
              // The filter predicate guarantees boolean values; the assertion
              // only re-states that for Object.fromEntries.
              entry.capabilities = Object.fromEntries(
                Object.entries(capRec).filter(([k, v]) => CAPABILITY_KEYS.includes(k) && typeof v === 'boolean'),
              ) as Record<string, boolean>;
            }
          }
        }
        const efforts = cfg.reasoning_efforts;
        if (efforts !== undefined) {
          if (!Array.isArray(efforts) || !efforts.every((e) => typeof e === 'string' && e.trim())) {
            errors.push(`MODELS_CONFIG: "${name}" reasoning_efforts must be an array of non-empty strings`);
          } else {
            entry.reasoning_efforts = efforts.map((e) => e.trim());
          }
        }
        // Schema reservation only: validated and carried, never routed on.
        const mods = cfg.modalities;
        if (mods !== undefined) {
          if (!mods || typeof mods !== 'object' || Array.isArray(mods)) {
            errors.push(`MODELS_CONFIG: "${name}" modalities must be an object { input, output }`);
          } else {
            const modRec = mods as Record<string, unknown>;
            const sides: { input: string[], output: string[] } = { input: [], output: [] };
            let valid = true;
            for (const side of ['input', 'output'] as const) {
              const list = modRec[side];
              if (!Array.isArray(list) || !list.every((t) => typeof t === 'string' && MODALITY_TOKENS.has(t.trim()))) {
                errors.push(`MODELS_CONFIG: "${name}" modalities.${side} must be an array over the closed vocabulary [${[...MODALITY_TOKENS].join(', ')}]`);
                valid = false;
              } else {
                sides[side] = [...new Set(list.map((t) => t.trim()))];
              }
            }
            if (valid) entry.modalities = { input: sides.input, output: sides.output };
          }
        }
        models[name.trim()] = entry;
      }
    }
  }
  cached = { models, errors };
  return cached;
}
