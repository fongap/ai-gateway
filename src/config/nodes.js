// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Config Layer: environment shards -> Runtime Node list.
//
//   TIER{1,2,3}_NODES_CONFIG_01..99  plain variables, JSON arrays of node
//                                    configs WITHOUT any credential material.
//   NODE_SECRETS_01..99              secrets, JSON objects { nodeId: credential }.
//
// Node JSON schema:
//   {
//     "id": "nvidia-01",                  // ^[a-z0-9][a-z0-9-]{0,63}$
//     "provider": "nvidia",               // optional label
//     "base_url": "https://.../v1",       // https required by default
//     "priority": 10,                     // smaller = higher precedence
//     "models": { "logical": "upstream" },// empty object = supports all models
//     "limits": { "concurrency": 1 }
//   }
//
// Tier is derived ONLY from the variable prefix. The node JSON must not carry
// a tier field; a tier field is rejected as invalid configuration.
//
// Configuration status:
//   unconfigured - key config vars are missing entirely
//   invalid      - config exists but no usable Runtime Node can be built,
//                  or structural conflicts exist (duplicate ids / secret keys)
//   degraded     - some nodes are unusable but at least one remains
//   ready        - all declared nodes are usable
//
// The result is cached for the isolate lifetime; env vars never change while
// an isolate is alive.

import { readEnv, getBool } from './env.js';
import { resolveProviderProfile } from './profiles.js';
import { loadModelsConfig, getModelsConfigDiagnostics } from './models.js';
import { loadPoliciesConfig, getPoliciesConfigDiagnostics } from './policies.js';

const SHARD_MAX_BYTES = 4500; // official variable size limit is 5 KB; keep margin
export const TIER_SHARD_PATTERN = /^TIER([123])_NODES_CONFIG_(\d{2})$/;
export const SECRET_SHARD_PATTERN = /^NODE_SECRETS_(\d{2})$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FORBIDDEN_NODE_FIELDS = ['token', 'credential', 'api_key', 'apikey', 'authorization', 'password', 'secret'];
// Fail-fast schema: any field outside this set is a typo/invalid and the node
// is rejected instead of being silently accepted (or emptied into a wildcard).
const ALLOWED_NODE_FIELDS = new Set(['id', 'provider', 'base_url', 'priority', 'models', 'limits']);
const ALLOWED_LIMITS_FIELDS = new Set(['concurrency', 'rpm', 'rpm_mode']);
const RPM_MODES = new Set(['soft', 'hard']);

let cachedEnv;
let cachedResult;

export function loadGatewayConfig(env) {
  if (cachedEnv === env && cachedResult) return cachedResult;
  cachedEnv = env;
  cachedResult = buildConfig(env);
  return cachedResult;
}

function buildConfig(env) {
  const diagnostics = [];
  const accessKeyBound = Boolean(readEnv(env, 'GATEWAY_ACCESS_KEY'));

  const tierShards = collectShards(env, TIER_SHARD_PATTERN, 'TIER1_NODES_CONFIG_', 'TIER1_NODES_CONFIG_01', 2, diagnostics);
  const secretShards = collectShards(env, SECRET_SHARD_PATTERN, 'NODE_SECRETS_', 'NODE_SECRETS_01', 1, diagnostics);
  const nodesDeclared = tierShards.reduce((sum, s) => sum + countArrayEntries(env[s.key]), 0);

  let status = 'unconfigured';
  if (!accessKeyBound || tierShards.length === 0) {
    return {
      status,
      ready: false,
      accessKeyBound,
      nodes: [],
      tiers: { 1: [], 2: [], 3: [] },
      bindings: {
        tierShards: tierShards.map((s) => s.key).sort(),
        secretShards: secretShards.map((s) => s.key).sort(),
      },
      nodesTotal: nodesDeclared,
      nodesUsable: 0,
      diagnostics,
    };
  }

  // Merge credential maps from all secret shards.
  const credentials = new Map();
  let conflict = false;
  const sortedSecretShards = [...secretShards].sort((a, b) => a.index - b.index);
  for (const shard of sortedSecretShards) {
    const parsed = parseJsonVar(env[shard.key], shard.key, diagnostics);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      diagnostics.push(`${shard.key}: must be a JSON object { nodeId: credential }`);
      conflict = true;
      continue;
    }
    for (const [nodeId, credential] of Object.entries(parsed)) {
      if (typeof credential !== 'string' || !credential.trim()) {
        diagnostics.push(`${shard.key}: credential for "${nodeId}" is empty`);
        conflict = true;
        continue;
      }
      if (credentials.has(nodeId)) {
        diagnostics.push(`credential id "${nodeId}" defined in multiple secret shards`);
        conflict = true;
        continue;
      }
      credentials.set(nodeId, credential);
    }
  }

  // Parse and validate node configs.
  const allowInsecure = getBool(env, 'ALLOW_INSECURE_HTTP_UPSTREAM', false);
  const seenIds = new Map();
  const nodes = [];
  const sortedTierShards = [...tierShards].sort((a, b) => a.tierNumber - b.tierNumber || a.index - b.index);
  for (const shard of sortedTierShards) {
    const tier = `tier-${shard.tierNumber}`;
    const parsed = parseJsonVar(env[shard.key], shard.key, diagnostics);
    if (!Array.isArray(parsed)) {
      diagnostics.push(`${shard.key}: must be a JSON array of node objects`);
      conflict = true;
      continue;
    }
    for (const rawNode of parsed) {
      const node = buildRuntimeNode(rawNode, tier, credentials, allowInsecure, shard.key, diagnostics);
      if (!node) continue;
      if (seenIds.has(node.id)) {
        diagnostics.push(`duplicate node id "${node.id}" (${seenIds.get(node.id)} and ${shard.key})`);
        conflict = true;
        continue;
      }
      seenIds.set(node.id, shard.key);
      nodes.push(node);
    }
  }

  // Credentials without a matching node are a configuration mistake.
  for (const [nodeId] of credentials) {
    if (!seenIds.has(nodeId)) diagnostics.push(`credential "${nodeId}" has no matching node config`);
  }

  // Auxiliary configs (MODELS_CONFIG / POLICIES_CONFIG) must be as strict as
  // the node config: malformed JSON, unknown fields, invalid capability types,
  // invalid max_attempts / tier_attempts all surface as diagnostics rather than
  // silently falling back to defaults.
  const auxDiagnostics = [
    ...getModelsConfigDiagnostics(env),
    ...getPoliciesConfigDiagnostics(env),
  ];
  // A model that references a policy which is not defined is a real misconfig.
  const models = loadModelsConfig(env);
  for (const [model, mcfg] of Object.entries(models)) {
    const pname = mcfg?.policy || 'default';
    if (!loadPoliciesConfig(env)[pname]) {
      auxDiagnostics.push(`MODELS_CONFIG: model "${model}" references unknown policy "${pname}"`);
    }
  }
  diagnostics.push(...auxDiagnostics);

  // Status semantics (strict, no contradictions):
  //   unconfigured  key config missing entirely            -> ready=false
  //   invalid       structural conflict OR zero usable     -> ready=false, never serve
  //   degraded      some nodes unusable OR an aux config is bad, >=1 usable -> ready=true
  //   ready         all declared nodes usable & aux configs clean -> ready=true
  if (conflict || nodes.length === 0) status = 'invalid';
  else if (nodes.length < nodesDeclared || auxDiagnostics.length > 0) status = 'degraded';
  else status = 'ready';
  const ready = status === 'ready' || status === 'degraded';

  // Precompute tier groups (priority-sorted) once per isolate; the scheduler
  // must not re-group or re-sort on the request hot path.
  const tiers = { 1: [], 2: [], 3: [] };
  for (const node of nodes) tiers[Number(node.tier.slice(5))].push(node);
  for (const list of Object.values(tiers)) list.sort((a, b) => a.priority - b.priority);

  return {
    status,
    ready,
    accessKeyBound,
    nodes,
    tiers,
    bindings: {
      tierShards: sortedTierShards.map((s) => s.key),
      secretShards: sortedSecretShards.map((s) => s.key),
    },
    nodesTotal: nodesDeclared,
    nodesUsable: nodes.length,
    diagnostics,
  };
}

// Build one Runtime Node or return null with a diagnostic reason.
function buildRuntimeNode(rawNode, tier, credentials, allowInsecure, sourceKey, diagnostics) {
  if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
    diagnostics.push(`${sourceKey}: entry is not a JSON object`);
    return null;
  }
  const id = typeof rawNode.id === 'string' ? rawNode.id.trim() : '';
  if (!ID_PATTERN.test(id)) {
    diagnostics.push(`${sourceKey}: node id "${String(rawNode.id).slice(0, 40)}" is missing or invalid (lowercase letters, digits, hyphens)`);
    return null;
  }
  if ('tier' in rawNode) {
    diagnostics.push(`node "${id}": "tier" field is not allowed; the tier comes from the variable name (${sourceKey})`);
    return null;
  }
  const forbidden = FORBIDDEN_NODE_FIELDS.filter((f) => f in rawNode);
  if (forbidden.length > 0) {
    diagnostics.push(`node "${id}": forbidden credential field(s) ${forbidden.join(', ')}; credentials belong in NODE_SECRETS_*`);
    return null;
  }
  // Fail-fast: reject unknown top-level fields (e.g. `prioirty` typo) instead of
  // silently ignoring them and guessing at intent.
  for (const key of Object.keys(rawNode)) {
    if (!ALLOWED_NODE_FIELDS.has(key)) {
      diagnostics.push(`node "${id}": unknown field "${key}" (allowed: ${[...ALLOWED_NODE_FIELDS].join(', ')})`);
      return null;
    }
  }

  const baseUrl = typeof rawNode.base_url === 'string' ? rawNode.base_url.trim() : '';
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    diagnostics.push(`node "${id}": base_url is missing or not a valid URL`);
    return null;
  }
  if (!allowInsecure && url.protocol !== 'https:') {
    diagnostics.push(`node "${id}": base_url must use https:// (set ALLOW_INSECURE_HTTP_UPSTREAM=true to override)`);
    return null;
  }
  if (url.username || url.password) {
    diagnostics.push(`node "${id}": base_url must not contain username/password`);
    return null;
  }

  const credential = credentials.get(id);
  if (!credential) {
    diagnostics.push(`node "${id}": no credential found in NODE_SECRETS_*; node excluded`);
    return null;
  }

  const models = normalizeModels(rawNode.models, id, diagnostics);
  if (models === null) return null;

  const priority = parsePriority(rawNode.priority, id, diagnostics);
  if (priority === null) return null;

  const limits = parseLimits(rawNode.limits, id, diagnostics);
  if (limits === null) return null;

  const providerLabel = typeof rawNode.provider === 'string' && rawNode.provider.trim() ? rawNode.provider.trim() : 'unknown';
  const profile = resolveProviderProfile(providerLabel);

  return {
    id,
    tier,
    provider: providerLabel,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    credential,
    priority,
    models,
    profile,
    limits: {
      concurrency: limits.concurrency ?? 2,
      // Soft/hard per-minute request quota; undefined = unlimited.
      ...(limits.rpm !== undefined ? { rpm: limits.rpm, rpmMode: limits.rpmMode ?? 'hard' } : {}),
    },
  };
}

function parsePriority(raw, nodeId, diagnostics) {
  if (raw === undefined) return 100;
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isFinite(n) || n < 0) {
    diagnostics.push(`node "${nodeId}": priority must be a non-negative number`);
    return null;
  }
  return Math.trunc(n);
}

function parseLimits(raw, nodeId, diagnostics) {
  const out = {};
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    diagnostics.push(`node "${nodeId}": limits must be an object { concurrency, rpm }`);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_LIMITS_FIELDS.has(key)) {
      diagnostics.push(`node "${nodeId}": limits.${key} is not a supported limit (allowed: ${[...ALLOWED_LIMITS_FIELDS].join(', ')})`);
      return null;
    }
  }
  const positiveInt = (value) => {
    const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
    return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : null;
  };
  if ('concurrency' in raw) {
    const c = positiveInt(raw.concurrency);
    if (c === null) {
      diagnostics.push(`node "${nodeId}": limits.concurrency must be an integer >= 1`);
      return null;
    }
    out.concurrency = c;
  }
  if ('rpm' in raw) {
    const r = positiveInt(raw.rpm);
    if (r === null) {
      diagnostics.push(`node "${nodeId}": limits.rpm must be an integer >= 1`);
      return null;
    }
    out.rpm = r;
    // An explicitly configured RPM is treated as a real upstream/account quota:
    // default to HARD (never exceed it locally). Opt back into the old
    // best-effort behavior with "rpm_mode": "soft".
    out.rpmMode = 'hard';
  }
  if ('rpm_mode' in raw) {
    const mode = typeof raw.rpm_mode === 'string' ? raw.rpm_mode.trim().toLowerCase() : '';
    if (!RPM_MODES.has(mode)) {
      diagnostics.push(`node "${nodeId}": limits.rpm_mode must be "soft" or "hard"`);
      return null;
    }
    out.rpmMode = mode;
  }
  return out;
}

function normalizeModels(models, nodeId, diagnostics) {
  const out = {};
  // Missing (`undefined`) => serve every configured logical model.
  if (models === undefined || models === null) return out;

  if (Array.isArray(models)) {
    // A list of model names (logical == upstream). Empty array => wildcard.
    if (models.length === 0) return out;
    for (const m of models) {
      if (typeof m !== 'string' || !m.trim()) {
        diagnostics.push(`node "${nodeId}": models array entries must be non-empty strings`);
        return null;
      }
      out[m.trim()] = m.trim();
    }
    return out;
  }

  // A scalar, boolean, etc. is an invalid structure, NOT a wildcard: never let
  // a typo'd/illegal config silently clear the map into "serve everything".
  if (typeof models !== 'object') {
    diagnostics.push(`node "${nodeId}": models must be an object { logical: upstream }`);
    return null;
  }

  const keys = Object.keys(models);
  if (keys.length === 0) return out; // explicit `{}` => wildcard

  for (const key of keys) {
    if (typeof key !== 'string' || !key.trim()) {
      diagnostics.push(`node "${nodeId}": models keys must be non-empty strings`);
      return null;
    }
    const value = models[key];
    if (typeof value !== 'string' || !value.trim()) {
      diagnostics.push(`node "${nodeId}": models["${key}"] must map to a non-empty upstream model string`);
      return null;
    }
    out[key.trim()] = value.trim();
  }
  return out;
}

// Collect shard variable names that match `pattern`. `indexGroup` is the
// 1-based capture group holding the numeric shard index (tier pattern has the
// index in group 2, secret pattern in group 1). Using the wrong group silently
// yields NaN and breaks ordering, so it is passed explicitly per pattern.
export function collectShards(env, pattern, loosePrefix, expectedExample, indexGroup, diagnostics) {
  const shards = [];
  for (const key of Object.keys(env || {})) {
    const match = pattern.exec(key);
    if (match) {
      shards.push({
        key,
        tierNumber: pattern.source.includes('TIER') ? Number(match[1]) : 0,
        index: Number(match[indexGroup]),
      });
      continue;
    }
    // Flag malformed sibling names so typos are never silently ignored.
    if (!pattern.test(key) && key.startsWith(loosePrefix)) {
      diagnostics.push(`${key}: malformed shard name (expected ${expectedExample}); ignored`);
    }
  }
  return shards;
}

function parseJsonVar(raw, key, diagnostics) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    diagnostics.push(`${key}: invalid JSON (${e.message})`);
    return null;
  }
}

function countArrayEntries(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}
