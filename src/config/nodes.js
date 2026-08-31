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
//     "provider": "nvidia",               // WHO provides it (label/quirks only)
//     "protocol": "openai",               // HOW to talk upstream: openai|anthropic
//     "surfaces": ["chat_completions"],   // WHICH endpoints the node really serves
//     "base_url": "https://.../v1",       // https required by default
//     "priority": 10,                     // smaller = higher precedence
//     "models": { "logical": "upstream" },// empty object = supports all models
//     "limits": { "concurrency": 1 }
//   }
//
// protocol decides: request format, upstream endpoint, auth header, protocol
// headers, stream wire format. surfaces decides which client surfaces can be
// routed to this node (openai: chat_completions|responses; anthropic: messages).
// provider is metadata only (dashboard / metrics / diagnostics / quirks) and
// never influences transport.
//
// Migration (deprecated, diagnostic-only, NOT fatal): a node without
// `protocol` defaults to "openai" and a node without `surfaces` defaults to
// ["chat_completions"] (openai) / ["messages"] (anthropic), because every
// pre-protocol node talked the OpenAI Chat wire format. Each implicit default
// emits a deprecation diagnostic so operators can make it explicit; the node
// still builds and the gateway is not marked invalid for it.
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
import { loadModelsConfig, getModelsConfigDiagnostics } from './models.js';
import { loadPoliciesConfig, getPoliciesConfigDiagnostics } from './policies.js';

const SHARD_MAX_BYTES = 4500; // official variable size limit is 5 KB; keep margin
export const TIER_SHARD_PATTERN = /^TIER([123])_NODES_CONFIG_(\d{2})$/;
export const SECRET_SHARD_PATTERN = /^NODE_SECRETS_(\d{2})$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FORBIDDEN_NODE_FIELDS = ['token', 'credential', 'api_key', 'apikey', 'authorization', 'password', 'secret'];
// Fail-fast schema: any field outside this set is a typo/invalid and the node
// is rejected instead of being silently accepted (or emptied into a wildcard).
const ALLOWED_NODE_FIELDS = new Set(['id', 'provider', 'protocol', 'surfaces', 'base_url', 'priority', 'models', 'limits']);
const ALLOWED_LIMITS_FIELDS = new Set(['concurrency', 'rpm', 'rpm_mode']);
const RPM_MODES = new Set(['soft', 'hard']);
// protocol -> which client surfaces the node can expose, and the implicit
// legacy default used when `surfaces` is omitted.
const PROTOCOL_SURFACES = new Map([
  ['openai', new Set(['chat_completions', 'responses'])],
  ['anthropic', new Set(['messages'])],
]);
const DEFAULT_SURFACES = new Map([
  ['openai', ['chat_completions']],
  ['anthropic', ['messages']],
]);

let cachedEnv;
let cachedResult;

export function loadGatewayConfig(env) {
  if (cachedEnv === env && cachedResult) return cachedResult;
  cachedEnv = env;
  cachedResult = buildConfig(env);
  return cachedResult;
}

// Strict diagnostics for MODELS_CONFIG / POLICIES_CONFIG plus the cross-reference
// check that every model's declared policy actually exists. These are FATAL.
function collectAuxConfigDiagnostics(env) {
  const diags = [
    ...getModelsConfigDiagnostics(env),
    ...getPoliciesConfigDiagnostics(env),
  ];
  const models = loadModelsConfig(env);
  const policies = loadPoliciesConfig(env);
  for (const [model, mcfg] of Object.entries(models)) {
    const pname = mcfg?.policy || 'default';
    if (!policies[pname]) {
      diags.push(`MODELS_CONFIG: model "${model}" references unknown policy "${pname}"`);
    }
  }
  return diags;
}

function buildConfig(env) {
  const diagnostics = [];
  // Strict aux configs (MODELS_CONFIG / POLICIES_CONFIG). Any structural error
  // here is FATAL: these configs are all-or-nothing, unlike node entries that
  // can be excluded. A malformed / unknown-field / invalid-value aux config
  // makes the gateway 'invalid' (ready=false) instead of guessing at intent.
  const auxDiagnostics = collectAuxConfigDiagnostics(env);
  diagnostics.push(...auxDiagnostics);
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

  // Status semantics (strict, no contradictions):
  //   unconfigured  key config missing entirely            -> ready=false
  //   invalid       structural conflict / zero usable / FATAL aux config error -> ready=false, never serve
  //   degraded      some nodes unusable, >=1 usable, aux configs clean -> ready=true
  //   ready         all declared nodes usable & aux configs clean -> ready=true
  // A FATAL aux config error (malformed JSON, unknown field, invalid
  // max_attempts / tier_attempts, undefined policy reference) is treated like a
  // structural conflict: it refuses service so the operator must fix it, rather
  // than silently serving traffic on guessed defaults.
  if (auxDiagnostics.length > 0) status = 'invalid';
  else if (conflict || nodes.length === 0) status = 'invalid';
  else if (nodes.length < nodesDeclared) status = 'degraded';
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

  const protocol = parseProtocol(rawNode.protocol, id, diagnostics);
  if (protocol === null) return null;
  const surfaces = parseSurfaces(rawNode.surfaces, protocol, id, diagnostics);
  if (surfaces === null) return null;

  const providerLabel = typeof rawNode.provider === 'string' && rawNode.provider.trim() ? rawNode.provider.trim() : 'unknown';

  return {
    id,
    tier,
    provider: providerLabel,
    protocol,
    surfaces,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    credential,
    priority,
    models,
    limits: {
      concurrency: limits.concurrency ?? 2,
      // Soft/hard per-minute request quota; undefined = unlimited.
      ...(limits.rpm !== undefined ? { rpm: limits.rpm, rpmMode: limits.rpmMode ?? 'hard' } : {}),
    },
  };
}

// protocol: openai | anthropic. Missing = legacy implicit "openai" (deprecated,
// diagnostic-only) because every pre-protocol node talked the OpenAI Chat wire.
function parseProtocol(raw, nodeId, diagnostics) {
  if (raw === undefined || raw === null) {
    diagnostics.push(`node "${nodeId}": protocol is implicit and defaults to "openai"; please configure it explicitly`);
    return 'openai';
  }
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!PROTOCOL_SURFACES.has(value)) {
    diagnostics.push(`node "${nodeId}": protocol must be "openai" or "anthropic"`);
    return null;
  }
  return value;
}

// surfaces: which endpoints this node really serves. Missing = legacy implicit
// default for the resolved protocol (deprecated, diagnostic-only). Explicit
// surfaces are strictly validated against the protocol.
function parseSurfaces(raw, protocol, nodeId, diagnostics) {
  if (raw === undefined || raw === null) {
    const def = DEFAULT_SURFACES.get(protocol);
    diagnostics.push(`node "${nodeId}": surfaces is implicit and defaults to [${def.map((s) => `"${s}"`).join(', ')}]; please configure it explicitly`);
    return def.slice();
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    diagnostics.push(`node "${nodeId}": surfaces must be a non-empty array`);
    return null;
  }
  const allowed = PROTOCOL_SURFACES.get(protocol);
  const out = [];
  for (const entry of raw) {
    const value = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (!allowed.has(value)) {
      diagnostics.push(`node "${nodeId}": surfaces entry "${String(entry).slice(0, 40)}" is not valid for protocol "${protocol}" (allowed: ${[...allowed].join(', ')})`);
      return null;
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
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
