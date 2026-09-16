#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Shared node-configuration sharding and planning module.
//
// Plain variables:
//   TIER{1,2,3}_NODES_CONFIG_01..10   JSON arrays of current node configs
// Secrets:
//   TIER{1,2,3}_NODES_SECRETS_01..10  JSON objects { nodeId: credential }
//
// Node config is account-level only. Protocol and surfaces are Provider wire
// capabilities owned by src/config/provider-profile.ts, not repeated here.

import fs from 'node:fs';

export const SHARD_MAX_BYTES = 4500;
export const MAX_SHARD_NUMBER = 10;

export const MANAGED_VAR_PATTERN = /^TIER[123]_NODES_CONFIG_(0[1-9]|10)$/;
export const MANAGED_SECRET_PATTERN = /^TIER[123]_NODES_SECRETS_(0[1-9]|10)$/;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VALID_TIER_PATTERN = /^[123]$/;
const FORBIDDEN_NODE_FIELDS = ['token', 'credential', 'api_key', 'apikey', 'authorization', 'password', 'secret'];
const ALLOWED_NODE_FIELDS = new Set(['id', 'provider', 'base_url', 'priority', 'models']);

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function pad(index) {
  if (!Number.isInteger(index) || index < 1 || index > MAX_SHARD_NUMBER) {
    throw new Error(`Invalid shard index: ${index} (expected 1..${MAX_SHARD_NUMBER})`);
  }
  return String(index).padStart(2, '0');
}

export function shardKeyName(kind, tierNumber, index) {
  if (!VALID_TIER_PATTERN.test(String(tierNumber))) {
    throw new Error(`Invalid tier number: ${tierNumber}`);
  }
  if (kind === 'var') return `TIER${tierNumber}_NODES_CONFIG_${pad(index)}`;
  if (kind === 'secret') return `TIER${tierNumber}_NODES_SECRETS_${pad(index)}`;
  throw new Error(`Unknown shard kind: ${kind}`);
}

export function parseJsonFile(filePath) {
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${filePath}: invalid JSON (${error.message})`);
  }
}

export function assertNodesArray(nodes, label = 'nodes config') {
  if (!Array.isArray(nodes)) throw new Error(`${label} must be a JSON array`);

  const seen = new Set();
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${label}: every entry must be an object`);
    }
    const node = raw;
    const id = typeof node.id === 'string' ? node.id.trim() : '';
    if (!ID_PATTERN.test(id)) {
      throw new Error(`${label}: node id "${String(node.id).slice(0, 40)}" missing or invalid (lowercase letters, digits, hyphens)`);
    }
    if (seen.has(id)) throw new Error(`${label}: duplicate node id "${id}"`);
    seen.add(id);

    const forbidden = FORBIDDEN_NODE_FIELDS.filter((field) => field in node);
    if (forbidden.length > 0) {
      throw new Error(`${label}: node "${id}" contains forbidden credential field(s): ${forbidden.join(', ')}. Credentials belong in TIER{1,2,3}_NODES_SECRETS_*.`);
    }
    if ('tier' in node) {
      throw new Error(`${label}: node "${id}" must not declare "tier"; the tier comes from the variable name`);
    }
    for (const key of Object.keys(node)) {
      if (!ALLOWED_NODE_FIELDS.has(key)) {
        throw new Error(`${label}: node "${id}" has unknown field "${key}" (allowed: ${[...ALLOWED_NODE_FIELDS].join(', ')})`);
      }
    }

    if (typeof node.provider !== 'string' || !node.provider.trim()) {
      throw new Error(`${label}: node "${id}" provider is required and must be a non-empty string`);
    }

    if (typeof node.base_url !== 'string' || !node.base_url.trim()) {
      throw new Error(`${label}: node "${id}" base_url is required`);
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(node.base_url.trim());
    } catch {
      throw new Error(`${label}: node "${id}" has an invalid base_url`);
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new Error(`${label}: node "${id}" needs an https:// base_url`);
    }
    if (parsedUrl.username || parsedUrl.password) {
      throw new Error(`${label}: node "${id}" base_url must not contain username/password`);
    }

    if (node.priority !== undefined
      && (typeof node.priority !== 'number'
        || !Number.isInteger(node.priority)
        || node.priority < 0)) {
      throw new Error(`${label}: node "${id}" priority must be a non-negative integer number`);
    }

    if (!node.models || typeof node.models !== 'object' || Array.isArray(node.models)) {
      throw new Error(`${label}: node "${id}" models is required and must be an object { logical: upstream }; use {} only for an intentional catalog-bounded wildcard`);
    }
    for (const [logical, upstream] of Object.entries(node.models)) {
      if (!logical.trim()) {
        throw new Error(`${label}: node "${id}" models keys must be non-empty strings`);
      }
      if (typeof upstream !== 'string' || !upstream.trim()) {
        throw new Error(`${label}: node "${id}" models["${logical}"] must map to a non-empty upstream model string`);
      }
    }
  }
}

export function assertSecretsObject(obj, label = 'node secrets') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${label} must be a JSON object { nodeId: credential }`);
  }
  for (const [id, credential] of Object.entries(obj)) {
    if (!ID_PATTERN.test(id)) throw new Error(`${label}: key "${id}" is not a valid node id`);
    if (typeof credential !== 'string' || !credential.trim()) {
      throw new Error(`${label}: credential for "${id}" must be a non-empty string`);
    }
  }
}

function splitEntries(entries, maxBytes) {
  const shards = [];
  let current = [];
  let currentBytes = 2;
  for (const [key, encoded, encodedBytes] of entries) {
    if (encodedBytes + 2 > maxBytes) {
      throw new Error(`Entry "${key}" itself is ${encodedBytes} bytes and exceeds the ${maxBytes}-byte shard limit; trim this entry.`);
    }
    const joiner = current.length > 0 ? 1 : 0;
    if (current.length > 0 && currentBytes + joiner + encodedBytes > maxBytes) {
      shards.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(encoded);
    currentBytes += joiner + encodedBytes;
  }
  if (current.length > 0) shards.push(current);
  return shards.map((list) => `[${list.join(',')}]`);
}

function nodesToEntries(nodes) {
  return nodes.map((node) => {
    const encoded = JSON.stringify(node);
    return [node.id, encoded, byteLength(encoded)];
  });
}

export function buildPlan({
  tiers,
  secretsMap,
  existingVarNames = [],
  existingSecretNames = [],
  maxBytes = SHARD_MAX_BYTES,
}) {
  const globalNodeIds = new Map();
  for (const tierNumber of [1, 2, 3]) {
    const nodes = tiers[tierNumber];
    if (!nodes) continue;
    assertNodesArray(nodes, `TIER${tierNumber} nodes config`);
    for (const node of nodes) {
      if (globalNodeIds.has(node.id)) {
        throw new Error(`duplicate node id "${node.id}" across TIER${globalNodeIds.get(node.id)} and TIER${tierNumber}`);
      }
      globalNodeIds.set(node.id, tierNumber);
    }
  }
  if (secretsMap !== undefined && secretsMap !== null) assertSecretsObject(secretsMap);

  if (secretsMap) {
    for (const id of Object.keys(secretsMap)) {
      if (!globalNodeIds.has(id)) throw new Error(`credential "${id}" has no matching node in any tier config`);
    }
    for (const id of globalNodeIds.keys()) {
      if (!(id in secretsMap)) throw new Error(`node "${id}" has no credential in the node secrets file`);
    }
  }

  const vars = {};
  const secrets = {};
  const plannedVars = [];
  const plannedSecrets = [];
  const tierSummary = {};

  for (const tierNumber of [1, 2, 3]) {
    const nodes = tiers[tierNumber];
    if (!nodes || nodes.length === 0) continue;
    const shards = splitEntries(nodesToEntries(nodes), maxBytes);
    shards.forEach((value, index) => {
      const key = shardKeyName('var', tierNumber, index + 1);
      vars[key] = value;
      plannedVars.push(key);
    });
    tierSummary[tierNumber] = { nodes: nodes.length, shards: shards.length };
  }

  if (secretsMap && Object.keys(secretsMap).length > 0) {
    for (const tierNumber of [1, 2, 3]) {
      const nodes = tiers[tierNumber];
      if (!nodes || nodes.length === 0) continue;
      const tierNodeIds = new Set(nodes.map((node) => node.id));
      const entries = Object.entries(secretsMap)
        .filter(([id]) => tierNodeIds.has(id))
        .sort(([a], [b]) => a.localeCompare(b));
      if (entries.length === 0) continue;

      const shards = [];
      let current = [];
      let currentBytes = 2;
      for (const [id, credential] of entries) {
        const pair = `${JSON.stringify(id)}:${JSON.stringify(credential)}`;
        if (byteLength(pair) + 2 > maxBytes) {
          throw new Error(`Credential "${id}" is too large for a single ${maxBytes}-byte shard.`);
        }
        const joiner = current.length > 0 ? 1 : 0;
        if (current.length > 0 && currentBytes + joiner + byteLength(pair) > maxBytes) {
          shards.push(current);
          current = [];
          currentBytes = 2;
        }
        current.push(pair);
        currentBytes += joiner + byteLength(pair);
      }
      if (current.length > 0) shards.push(current);

      shards.forEach((pairs, index) => {
        const key = shardKeyName('secret', tierNumber, index + 1);
        secrets[key] = `{${pairs.join(',')}}`;
        plannedSecrets.push(key);
      });
      tierSummary[tierNumber].secretShards = shards.length;
    }
  }

  const plannedVarSet = new Set(plannedVars);
  const deleteVars = [...new Set(existingVarNames)]
    .filter((name) => MANAGED_VAR_PATTERN.test(name) && !plannedVarSet.has(name))
    .sort();
  const plannedSecretSet = new Set(plannedSecrets);
  const deleteSecrets = [...new Set(existingSecretNames)]
    .filter((name) => MANAGED_SECRET_PATTERN.test(name) && !plannedSecretSet.has(name))
    .sort();

  return {
    vars,
    secrets,
    plannedVars,
    plannedSecrets,
    deleteVars,
    deleteSecrets,
    tierSummary,
  };
}
