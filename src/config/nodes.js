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

const SHARD_MAX_BYTES = 4500; // official variable size limit is 5 KB; keep margin
const TIER_SHARD_PATTERN = /^TIER([123])_NODES_CONFIG_(\d{2})$/;
const SECRET_SHARD_PATTERN = /^NODE_SECRETS_(\d{2})$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FORBIDDEN_NODE_FIELDS = ['token', 'credential', 'api_key', 'apikey', 'authorization', 'password', 'secret'];

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

  const tierShards = collectShards(env, TIER_SHARD_PATTERN, 'TIER1_NODES_CONFIG_', 'TIER1_NODES_CONFIG_01', diagnostics);
  const secretShards = collectShards(env, SECRET_SHARD_PATTERN, 'NODE_SECRETS_', 'NODE_SECRETS_01', diagnostics);
  const nodesDeclared = tierShards.reduce((sum, s) => sum + countArrayEntries(env[s.key]), 0);

  let status = 'unconfigured';
  if (!accessKeyBound || tierShards.length === 0) {
    return {
      status,
      ready: false,
      accessKeyBound,
      nodes: [],
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

  if (conflict) status = 'invalid';
  else if (nodes.length === 0) status = 'invalid';
  else if (nodes.length < nodesDeclared) status = 'degraded';
  else status = 'ready';

  return {
    status,
    ready: nodes.length > 0,
    accessKeyBound,
    nodes,
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

  const priority = Number(rawNode.priority);
  const concurrency = Number(rawNode.limits?.concurrency);

  return {
    id,
    tier,
    provider: typeof rawNode.provider === 'string' && rawNode.provider.trim() ? rawNode.provider.trim() : 'unknown',
    baseUrl: baseUrl.replace(/\/+$/, ''),
    credential,
    priority: Number.isFinite(priority) ? priority : 100,
    models,
    limits: { concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.trunc(concurrency) : 2 },
  };
}

function normalizeModels(models, nodeId, diagnostics) {
  const out = {};
  if (Array.isArray(models)) {
    for (const m of models) {
      if (typeof m === 'string' && m.trim()) out[m.trim()] = m.trim();
    }
    return out;
  }
  if (!models) return out;
  if (typeof models !== 'object' || Array.isArray(models)) {
    diagnostics.push(`node "${nodeId}": models must be an object { logical: upstream }`);
    return null;
  }
  for (const [k, v] of Object.entries(models)) {
    if (typeof k === 'string' && k.trim() && typeof v === 'string' && v.trim()) out[k.trim()] = v.trim();
  }
  return out;
}

function collectShards(env, pattern, loosePrefix, expectedExample, diagnostics) {
  const shards = [];
  for (const key of Object.keys(env || {})) {
    const match = pattern.exec(key);
    if (match) {
      shards.push({
        key,
        tierNumber: pattern.source.includes('TIER') ? Number(match[1]) : 0,
        index: Number(match[2]),
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
