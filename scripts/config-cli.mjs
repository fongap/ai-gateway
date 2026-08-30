#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// ai-gateway configuration CLI.
//
// Local operator tool for the individual-shard configuration model. Reads
// tier / secrets / models / policies JSON files and validates, summarises,
// diffs, and migrates the legacy GATEWAY_CONFIG / GATEWAY_SECRETS_CONFIG blobs
// into the individual-shard structure.
//
// This CLI is an enhancement; it is NOT a deployment prerequisite. Operators
// can still maintain Variables / Secrets directly in the GitHub UI.
//
// Subcommands:
//   check   Validate node configs + secrets + cross-references and shard sizes
//   show    Print a per-node summary (tier, provider, models, credential state)
//   diff    Compare two configurations and print added/removed/changed items
//   migrate Parse the legacy GATEWAY_CONFIG / GATEWAY_SECRETS_CONFIG blobs
//           and emit a manifest (and optionally individual shard files)
//
// Secret values are NEVER printed. Credential state is reported as
// "configured" or "missing" only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseJsonFile, assertNodesArray, assertSecretsObject, buildPlan,
  MANAGED_VAR_PATTERN, MANAGED_SECRET_PATTERN, SHARD_MAX_BYTES,
} from './node-config-shards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function warn(message) {
  console.error(`WARNING: ${message}`);
}

function parseArgs(argv, schema) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) fail(`unknown argument: ${token}`);
    const key = token.slice(2);
    if (!(key in schema)) fail(`unknown argument: --${key}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) fail(`--${key} requires a value`);
    out[key] = next;
    i++;
  }
  for (const [key, meta] of Object.entries(schema)) {
    if (meta.required && !(key in out)) fail(`--${key} is required`);
  }
  return out;
}

function readOptionalJson(filePath, label) {
  if (!filePath) return null;
  try {
    return parseJsonFile(filePath);
  } catch (e) {
    fail(`${label} file "${filePath}": ${e.message}`);
  }
}

function loadTiers(args) {
  const tiers = {};
  for (const n of [1, 2, 3]) {
    if (args[`tier${n}`]) {
      try {
        tiers[n] = parseJsonFile(args[`tier${n}`]);
      } catch (e) {
        fail(`--tier${n} ${args[`tier${n}`]}: ${e.message}`);
      }
    }
  }
  return tiers;
}

function loadSecrets(args) {
  if (!args.secrets) return null;
  try {
    return parseJsonFile(args.secrets);
  } catch (e) {
    fail(`--secrets ${args.secrets}: ${e.message}`);
  }
}

function loadOptionalJSONMap(filePath) {
  if (!filePath) return null;
  try {
    return parseJsonFile(filePath);
  } catch (e) {
    fail(`"${filePath}": ${e.message}`);
  }
}

function nodeById(tiers) {
  const map = new Map();
  for (const tierNumber of [1, 2, 3]) {
    for (const node of tiers[tierNumber] || []) map.set(node.id, { node, tier: tierNumber });
  }
  return map;
}

function modelsFromConfig(modelsConfig) {
  if (!modelsConfig || typeof modelsConfig !== 'object') return 0;
  return Object.keys(modelsConfig).length;
}

function policiesFromConfig(policiesConfig) {
  if (!policiesConfig || typeof policiesConfig !== 'object') return 0;
  return Object.keys(policiesConfig).length;
}

function shardByteSizes(plan) {
  return Object.fromEntries(
    Object.entries(plan.vars).map(([k, v]) => [k, Buffer.byteLength(v, 'utf8')])
  );
}

function runCheck(args) {
  const schema = {
    tier1: { required: false }, tier2: { required: false }, tier3: { required: false },
    secrets: { required: true },
    models: { required: false }, policies: { required: false },
  };
  const a = parseArgs(args, schema);
  const tiers = loadTiers(a);
  if (Object.keys(tiers).length === 0) fail('at least one of --tier1/--tier2/--tier3 is required');
  for (const [n, nodes] of Object.entries(tiers)) {
    try { assertNodesArray(nodes, `tier-${n}`); } catch (e) { fail(e.message); }
  }
  const secrets = loadSecrets(a);
  try { assertSecretsObject(secrets, 'secrets'); } catch (e) { fail(e.message); }

  const modelsConfig = loadOptionalJSONMap(a.models);
  if (modelsConfig && typeof modelsConfig !== 'object') fail('--models must be a JSON object');
  const policiesConfig = loadOptionalJSONMap(a.policies);
  if (policiesConfig && typeof policiesConfig !== 'object') fail('--policies must be a JSON object');

  // Cross-validation: node without credential is an error; credential without
  // node is a warning (orphan credentials are tolerated, never block deploy).
  const nodeIds = new Set();
  for (const tierNumber of [1, 2, 3]) for (const node of tiers[tierNumber] || []) nodeIds.add(node.id);
  for (const id of Object.keys(secrets || {})) {
    if (!nodeIds.has(id)) warn(`credential "${id}" has no matching node in any tier config`);
  }
  for (const id of nodeIds) {
    if (!(id in (secrets || {}))) fail(`node "${id}" has no credential in the secrets file`);
  }

  // buildPlan rejects orphan credentials; feed it only matched credentials
  // so an orphan warning does not turn into an error.
  const matchedSecrets = Object.fromEntries(Object.entries(secrets || {}).filter(([id]) => nodeIds.has(id)));

  let plan;
  try {
    plan = buildPlan({ tiers, secretsMap: matchedSecrets });
  } catch (e) {
    fail(e.message);
  }

  // Shard size sanity (buildPlan already enforces; double-check with a clear message)
  for (const [name, size] of Object.entries(shardByteSizes(plan))) {
    if (size > SHARD_MAX_BYTES) fail(`${name} is ${size} bytes, exceeds the ${SHARD_MAX_BYTES}-byte shard limit`);
  }

  const models = modelsFromConfig(modelsConfig);
  const policies = policiesFromConfig(policiesConfig);
  const lines = ['Configuration valid', ''];
  for (const n of [1, 2, 3]) lines.push(`Tier ${n}: ${(tiers[n] || []).length} node(s)`);
  lines.push('');
  if (models) lines.push(`Models: ${models}`);
  if (policies) lines.push(`Policies: ${policies}`);
  lines.push('');
  lines.push(`Node secret shards: ${Object.keys(plan.secrets).length}`);
  lines.push('All configured nodes have credentials.');
  console.log(lines.join('\n'));
}

function runShow(args) {
  const schema = {
    tier1: { required: false }, tier2: { required: false }, tier3: { required: false },
    secrets: { required: true },
  };
  const a = parseArgs(args, schema);
  const tiers = loadTiers(a);
  const secrets = loadSecrets(a);
  try { assertSecretsObject(secrets, 'secrets'); } catch (e) { fail(e.message); }
  for (const [n, nodes] of Object.entries(tiers)) {
    try { assertNodesArray(nodes, `tier-${n}`); } catch (e) { fail(e.message); }
  }
  const map = nodeById(tiers);
  const sorted = [...map.values()].sort((a, b) => a.tier - b.tier || a.node.id.localeCompare(b.node.id));
  for (const { node, tier } of sorted) {
    const credState = node.id in (secrets || {}) ? 'configured' : 'missing';
    const models = Object.keys(node.models || {}).join(', ') || '(wildcard)';
    console.log(node.id);
    console.log(`  Tier: ${tier}`);
    console.log(`  Provider: ${node.provider || '(unspecified)'}`);
    console.log(`  Models: ${models}`);
    console.log(`  Credential: ${credState}`);
  }
}

function normalizeRuntimeKeys(obj) {
  return obj ? new Set(Object.keys(obj)) : new Set();
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function runDiff(args) {
  const schema = {
    'old-tier1': { required: false }, 'old-tier2': { required: false }, 'old-tier3': { required: false },
    'new-tier1': { required: false }, 'new-tier2': { required: false }, 'new-tier3': { required: false },
    'old-secrets': { required: false }, 'new-secrets': { required: false },
    'old-models': { required: false }, 'new-models': { required: false },
    'old-policies': { required: false }, 'new-policies': { required: false },
  };
  const a = parseArgs(args, schema);
  if (!a['old-tier1'] && !a['new-tier1']) fail('provide at least --old-tier1 / --new-tier1');

  const oldTiers = loadTiers({ tier1: a['old-tier1'], tier2: a['old-tier2'], tier3: a['old-tier3'] });
  const newTiers = loadTiers({ tier1: a['new-tier1'], tier2: a['new-tier2'], tier3: a['new-tier3'] });
  const oldSecrets = a['old-secrets'] ? parseJsonFile(a['old-secrets']) : {};
  const newSecrets = a['new-secrets'] ? parseJsonFile(a['new-secrets']) : {};

  const oldMap = nodeById(oldTiers);
  const newMap = nodeById(newTiers);
  const allIds = new Set([...oldMap.keys(), ...newMap.keys()]);
  const nodeLines = [];
  for (const id of [...allIds].sort()) {
    const oldEntry = oldMap.get(id);
    const newEntry = newMap.get(id);
    if (oldEntry && !newEntry) nodeLines.push(`- ${id}`);
    else if (!oldEntry && newEntry) nodeLines.push(`+ ${id}`);
    else if (oldEntry && newEntry) {
      if (!deepEqual({ ...oldEntry.node, tier: undefined }, { ...newEntry.node, tier: undefined })) {
        nodeLines.push(`~ ${id}`);
      }
    }
  }

  const oldShards = new Set(Object.keys(oldSecrets || {}));
  const newShards = new Set(Object.keys(newSecrets || {}));
  const secretLines = [];
  for (const id of [...newShards].sort()) {
    if (!oldShards.has(id)) secretLines.push(`+ ${id}`);
  }
  for (const id of [...oldShards].sort()) {
    if (!newShards.has(id)) secretLines.push(`- ${id}`);
  }
  for (const id of [...newShards].sort()) {
    if (oldShards.has(id) && !deepEqual(oldSecrets[id], newSecrets[id])) secretLines.push(`~ ${id}`);
  }

  const runtimeLines = [];
  if (a['old-models'] || a['new-models']) {
    const oldM = a['old-models'] ? parseJsonFile(a['old-models']) : null;
    const newM = a['new-models'] ? parseJsonFile(a['new-models']) : null;
    if (oldM && !newM) runtimeLines.push('- MODELS_CONFIG');
    else if (!oldM && newM) runtimeLines.push('+ MODELS_CONFIG');
    else if (oldM && newM && !deepEqual(oldM, newM)) runtimeLines.push('~ MODELS_CONFIG');
    else if (oldM && newM && deepEqual(oldM, newM)) runtimeLines.push('= MODELS_CONFIG');
  }
  if (a['old-policies'] || a['new-policies']) {
    const oldP = a['old-policies'] ? parseJsonFile(a['old-policies']) : null;
    const newP = a['new-policies'] ? parseJsonFile(a['new-policies']) : null;
    if (oldP && !newP) runtimeLines.push('- POLICIES_CONFIG');
    else if (!oldP && newP) runtimeLines.push('+ POLICIES_CONFIG');
    else if (oldP && newP && !deepEqual(oldP, newP)) runtimeLines.push('~ POLICIES_CONFIG');
    else if (oldP && newP && deepEqual(oldP, newP)) runtimeLines.push('= POLICIES_CONFIG');
  }

  if (nodeLines.length) {
    console.log('Nodes:');
    for (const l of nodeLines) console.log(l);
  }
  if (runtimeLines.length) {
    console.log('');
    console.log('Runtime:');
    for (const l of runtimeLines) console.log(l);
  }
  if (secretLines.length) {
    console.log('');
    console.log('Secrets:');
    for (const l of secretLines) console.log(l);
  }
  if (!nodeLines.length && !runtimeLines.length && !secretLines.length) console.log('No changes.');
}

function runMigrate(args) {
  const schema = {
    'gateway-config': { required: true },
    'gateway-secrets': { required: true },
    out: { required: false },
    'include-access-key': { required: false },
  };
  const a = parseArgs(args, schema);
  const blob = parseJsonFile(a['gateway-config'], 'GATEWAY_CONFIG');
  const secretsBlob = parseJsonFile(a['gateway-secrets'], 'GATEWAY_SECRETS_CONFIG');

  console.error('WARNING: GATEWAY_CONFIG is deprecated. Migrate to individual GitHub Repository Variables.');
  console.error('WARNING: GATEWAY_SECRETS_CONFIG is deprecated. Migrate to GATEWAY_ACCESS_KEY + NODE_SECRETS_XX.');

  const variables = ['CLOUDFLARE_ACCOUNT_ID', 'TOKEN_STATS_D1_ID', 'GATEWAY_PUBLIC_BASE_URL'];
  for (const [key, value] of Object.entries(blob)) {
    if (MANAGED_VAR_PATTERN.test(key)) variables.push(key);
    else if (key === 'MODELS_CONFIG' || key === 'POLICIES_CONFIG') variables.push(key);
  }
  const secrets = [];
  for (const key of Object.keys(secretsBlob)) {
    if (key === 'GATEWAY_ACCESS_KEY' || MANAGED_SECRET_PATTERN.test(key)) secrets.push(key);
  }

  console.log('Variables:');
  for (const v of variables) console.log(v);
  console.log('');
  console.log('Secrets:');
  for (const s of secrets) console.log(s);

  if (a.out) {
    const outDir = a.out;
    fs.mkdirSync(outDir, { recursive: true });
    for (const [key, value] of Object.entries(blob)) {
      if (MANAGED_VAR_PATTERN.test(key) || key === 'MODELS_CONFIG' || key === 'POLICIES_CONFIG') {
        const payload = typeof value === 'string' ? value : JSON.stringify(value);
        fs.writeFileSync(path.join(outDir, `${key}.json`), payload + '\n');
      }
    }
    for (const [key, value] of Object.entries(secretsBlob)) {
      if (MANAGED_SECRET_PATTERN.test(key)) {
        const payload = typeof value === 'string' ? value : JSON.stringify(value);
        fs.writeFileSync(path.join(outDir, `${key}.json`), payload + '\n');
      }
    }
    if (a['include-access-key']) {
      fs.writeFileSync(path.join(outDir, 'GATEWAY_ACCESS_KEY'), secretsBlob.GATEWAY_ACCESS_KEY);
    } else {
      console.log('');
      console.log('GATEWAY_ACCESS_KEY: set manually in GitHub Secret (value not written to disk)');
    }
  }
}

const USAGE = `usage: config-cli.mjs <check|show|diff|migrate> [options]

  check   --tier1 FILE [--tier2 FILE] [--tier3 FILE] --secrets FILE [--models FILE] [--policies FILE]
  show    --tier1 FILE [--tier2 FILE] [--tier3 FILE] --secrets FILE
  diff    --old-tier1 FILE --new-tier1 FILE [--old-tier2 FILE --new-tier2 FILE] [--old-tier3 FILE --new-tier3 FILE]
          [--old-secrets FILE --new-secrets FILE]
          [--old-models FILE --new-models FILE] [--old-policies FILE --new-policies FILE]
  migrate --gateway-config FILE --gateway-secrets FILE [--out DIR] [--include-access-key]`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || !['check', 'show', 'diff', 'migrate'].includes(command)) {
    console.error(USAGE);
    process.exit(command ? 1 : 0);
  }
  try {
    if (command === 'check') runCheck(rest);
    else if (command === 'show') runShow(rest);
    else if (command === 'diff') runDiff(rest);
    else if (command === 'migrate') runMigrate(rest);
  } catch (e) {
    if (e && e.message) console.error(`error: ${e.message}`);
    else console.error(e);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
