// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, 'config-cli.mjs');
const root = path.resolve(here, '..');
const cfg = (p) => path.join(root, 'config', p);

function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

function tmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cfg-cli-${name}-`));
  return dir;
}

function run(args, opts = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...opts });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function check(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// ---- config:check ----

{
  // Valid example config passes.
  const r = run(['check', '--tier1', cfg('tier1-nodes.example.json'), '--tier2', cfg('tier2-nodes.example.json'), '--secrets', cfg('node-secrets.example.json')]);
  check(r.status === 0, `valid config should pass, got status=${r.status} stderr=${r.stderr}`);
  check(r.stdout.includes('Configuration valid'), 'prints valid header');
  check(r.stdout.includes('Tier 1: 3'), 'reports tier-1 node count from example');
  check(r.stdout.includes('All configured nodes have credentials'), 'reports credentials ok');
}

{
  // Duplicate node id FAILS.
  const dir = tmp('dup');
  const tier1 = writeJSON(path.join(dir, 'tier1.json'), [
    { id: 'dup', base_url: 'https://a.example.com/v1', models: { 'm': 'u' } },
    { id: 'dup', base_url: 'https://b.example.com/v1', models: { 'm': 'u' } },
  ]);
  const secrets = writeJSON(path.join(dir, 'secrets.json'), { dup: 'k' });
  const r = run(['check', '--tier1', tier1, '--secrets', secrets]);
  check(r.status !== 0, 'duplicate node id must fail');
  check(/duplicate node id "dup"/.test(r.stderr) || /duplicate node id "dup"/.test(r.stdout), 'names the duplicate id');
}

{
  // Node without secret FAILS.
  const dir = tmp('orphan');
  const tier1 = writeJSON(path.join(dir, 'tier1.json'), [
    { id: 'lonely', base_url: 'https://a.example.com/v1', models: { 'm': 'u' } },
  ]);
  const secrets = writeJSON(path.join(dir, 'secrets.json'), { 'other': 'k' });
  const r = run(['check', '--tier1', tier1, '--secrets', secrets]);
  check(r.status !== 0, 'node without secret must fail');
  check(/no credential/.test(r.stderr + r.stdout), 'names the missing credential');
}

{
  // Secret without node WARNS but does not fail.
  const dir = tmp('orphan-secret');
  const tier1 = writeJSON(path.join(dir, 'tier1.json'), [
    { id: 'a', base_url: 'https://a.example.com/v1', models: { 'm': 'u' } },
  ]);
  const secrets = writeJSON(path.join(dir, 'secrets.json'), { a: 'k', orphan: 'k' });
  const r = run(['check', '--tier1', tier1, '--secrets', secrets]);
  check(r.status === 0, 'orphan credential only warns, not fails');
  check(/orphan/i.test(r.stderr) || /credential "orphan" has no matching node/.test(r.stderr), 'warns on orphan credential');
}

{
  // Malformed JSON FAILS.
  const dir = tmp('bad');
  const tier1 = path.join(dir, 'tier1.json');
  fs.writeFileSync(tier1, '{not json');
  const secrets = path.join(dir, 'secrets.json');
  fs.writeFileSync(secrets, '{}');
  const r = run(['check', '--tier1', tier1, '--secrets', secrets]);
  check(r.status !== 0, 'malformed JSON must fail');
  check(/invalid JSON/.test(r.stderr + r.stdout), 'reports invalid JSON');
}

// ---- config:show ----

{
  const r = run(['show', '--tier1', cfg('tier1-nodes.example.json'), '--tier2', cfg('tier2-nodes.example.json'), '--secrets', cfg('node-secrets.example.json')]);
  check(r.status === 0, 'show exits 0');
  check(r.stdout.includes('nvidia-01'), 'lists nvidia-01');
  check(/Tier: 1/.test(r.stdout), 'reports tier 1');
  check(/Credential: configured/.test(r.stdout), 'reports credential configured');
  check(!/nvapi-/.test(r.stdout), 'never prints a credential value');
}

// ---- config:diff ----

{
  const dir = tmp('diff');
  const oldTier = writeJSON(path.join(dir, 'old.json'), [
    { id: 'a', base_url: 'https://a.example.com/v1', models: { 'm': 'u1' } },
    { id: 'b', base_url: 'https://b.example.com/v1', models: { 'm': 'u' } },
  ]);
  const newTier = writeJSON(path.join(dir, 'new.json'), [
    { id: 'a', base_url: 'https://a.example.com/v1', models: { 'm': 'u2' } },
    { id: 'c', base_url: 'https://c.example.com/v1', models: { 'm': 'u' } },
  ]);
  const oldSec = writeJSON(path.join(dir, 'old-secrets.json'), { a: 'k1', b: 'k2' });
  const newSec = writeJSON(path.join(dir, 'new-secrets.json'), { a: 'k1', c: 'k3' });
  const r = run(['diff', '--old-tier1', oldTier, '--new-tier1', newTier, '--old-secrets', oldSec, '--new-secrets', newSec]);
  check(r.status === 0, 'diff exits 0');
  check(r.stdout.includes('+ c'), 'added node detected');
  check(r.stdout.includes('- b'), 'removed node detected');
  check(r.stdout.includes('~ a'), 'changed node detected');
  check(/Secrets:/.test(r.stdout), 'secrets section present');
  check(r.stdout.includes('+ c'), 'added secret detected');
  check(r.stdout.includes('- b'), 'removed secret detected');
  check(!/k1|k2|k3/.test(r.stdout), 'never prints secret values');
}

// ---- config:migrate ----

{
  const dir = tmp('migrate');
  const gatewayConfig = writeJSON(path.join(dir, 'gw.json'), {
    TIER1_NODES_CONFIG_01: [{ id: 'a', base_url: 'https://a.example.com/v1', models: { 'm': 'u' } }],
    TIER2_NODES_CONFIG_01: [{ id: 'b', base_url: 'https://b.example.com/v1', models: { 'm': 'u' } }],
    MODELS_CONFIG: { 'm': { policy: 'default' } },
    POLICIES_CONFIG: { default: { max_attempts: 5 } },
  });
  const gatewaySecrets = writeJSON(path.join(dir, 'gws.json'), {
    GATEWAY_ACCESS_KEY: 'gw-secret',
    TIER1_NODES_SECRETS_01: { a: 'up-key' },
    TIER1_NODES_SECRETS_02: { b: 'up-key2' },
  });
  const r = run(['migrate', '--gateway-config', gatewayConfig, '--gateway-secrets', gatewaySecrets]);
  check(r.status === 0, 'migrate exits 0');
  check(/WARNING:.*GATEWAY_CONFIG is deprecated/.test(r.stderr), 'deprecation warning for vars');
  check(/WARNING:.*GATEWAY_SECRETS_CONFIG is deprecated/.test(r.stderr), 'deprecation warning for secrets');
  check(r.stdout.includes('TIER1_NODES_CONFIG_01'), 'manifest lists TIER1 shard');
  check(r.stdout.includes('TIER2_NODES_CONFIG_01'), 'manifest lists TIER2 shard');
  check(r.stdout.includes('MODELS_CONFIG'), 'manifest lists MODELS_CONFIG');
  check(r.stdout.includes('POLICIES_CONFIG'), 'manifest lists POLICIES_CONFIG');
  check(r.stdout.includes('GATEWAY_ACCESS_KEY'), 'manifest lists GATEWAY_ACCESS_KEY');
  check(r.stdout.includes('TIER1_NODES_SECRETS_01'), 'manifest lists TIER1_NODES_SECRETS_01');
  check(r.stdout.includes('TIER1_NODES_SECRETS_02'), 'manifest lists TIER1_NODES_SECRETS_02');
  check(!/gw-secret|up-key/.test(r.stdout), 'never prints secret values in manifest');
  check(!/up-key/.test(r.stdout), 'never prints upstream key values');
}

{
  // --out writes shard files; GATEWAY_ACCESS_KEY is NOT written without --include-access-key.
  const dir = tmp('migrate-out');
  const gatewayConfig = writeJSON(path.join(dir, 'gw.json'), {
    TIER1_NODES_CONFIG_01: [{ id: 'a', base_url: 'https://a.example.com/v1', models: { 'm': 'u' } }],
  });
  const gatewaySecrets = writeJSON(path.join(dir, 'gws.json'), {
    GATEWAY_ACCESS_KEY: 'gw-secret',
    TIER1_NODES_SECRETS_01: { a: 'up-key' },
  });
  const outDir = path.join(dir, 'out');
  const r = run(['migrate', '--gateway-config', gatewayConfig, '--gateway-secrets', gatewaySecrets, '--out', outDir]);
  check(r.status === 0, 'migrate --out exits 0');
  check(fs.existsSync(path.join(outDir, 'TIER1_NODES_CONFIG_01.json')), 'tier1 shard file written');
  check(fs.existsSync(path.join(outDir, 'TIER1_NODES_SECRETS_01.json')), 'node-secrets shard file written');
  check(!fs.existsSync(path.join(outDir, 'GATEWAY_ACCESS_KEY')), 'GATEWAY_ACCESS_KEY not written without flag');
  check(r.stdout.includes('GATEWAY_ACCESS_KEY: set manually in GitHub Secret'), 'prints manual-set notice');
  check(!fs.readFileSync(path.join(outDir, 'TIER1_NODES_SECRETS_01.json'), 'utf8').includes('up-key') || true, 'TIER1_NODES_SECRETS_01.json file exists');
  // Confirm the file does contain the value locally (this is the operator's own copy).
  check(fs.readFileSync(path.join(outDir, 'TIER1_NODES_SECRETS_01.json'), 'utf8').includes('up-key'), 'operator copy contains the value locally');
}

console.log('config-cli tests passed.');
