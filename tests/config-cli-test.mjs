// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const cli = path.join(root, 'scripts', 'config-cli.mjs');
const cfg = (p) => path.join(root, 'config', p);
function writeJSON(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); return file; }
function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `cfg-cli-${name}-`)); }
function run(args) { const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' }); return { status: result.status, stdout: result.stdout, stderr: result.stderr }; }
function check(cond, msg) { if (!cond) throw new Error(`assertion failed: ${msg}`); }
function explicitNode(id, base = `https://${id}.example.com/v1`, model = 'u') {
  return { id, provider: 'mock', base_url: base, models: { m: model } };
}
function tier1ExampleSecrets() {
  const nodes = JSON.parse(fs.readFileSync(cfg('tier1-nodes.example.json'), 'utf8'));
  const dir = tmp('example-secrets');
  return writeJSON(path.join(dir, 'secrets.json'), Object.fromEntries(nodes.map((n) => [n.id, `secret-${n.id}`])));
}

{
  const secrets = tier1ExampleSecrets();
  const r = run(['check', '--tier1', cfg('tier1-nodes.example.json'), '--secrets', secrets]);
  check(r.status === 0, `valid config should pass, got status=${r.status} stderr=${r.stderr}`);
  check(r.stdout.includes('Configuration valid'), 'prints valid header');
  check(r.stdout.includes('Tier 1: 3'), 'reports tier-1 node count');
  check(r.stdout.includes('All configured nodes have credentials'), 'reports credentials ok');
}
{
  const dir = tmp('dup');
  const tier1 = writeJSON(path.join(dir, 'tier1.json'), [explicitNode('dup', 'https://a.example.com/v1'), explicitNode('dup', 'https://b.example.com/v1')]);
  const secrets = writeJSON(path.join(dir, 'secrets.json'), { dup: 'k' });
  const r = run(['check', '--tier1', tier1, '--secrets', secrets]);
  check(r.status !== 0, 'duplicate node id must fail');
  check(/duplicate node id "dup"/.test(r.stderr + r.stdout), 'names the duplicate id');
}
{
  const dir = tmp('strict');
  const broken = explicitNode('broken'); delete broken.provider;
  const tier1 = writeJSON(path.join(dir, 'tier1.json'), [broken]);
  const secrets = writeJSON(path.join(dir, 'secrets.json'), { broken: 'k' });
  const r = run(['check', '--tier1', tier1, '--secrets', secrets]);
  check(r.status !== 0, 'missing provider must fail');
  check(/provider/i.test(r.stderr + r.stdout), 'strict-schema error names provider');
}
{
  const dir = tmp('orphan');
  const tier1 = writeJSON(path.join(dir, 'tier1.json'), [explicitNode('lonely')]);
  const secrets = writeJSON(path.join(dir, 'secrets.json'), { other: 'k' });
  const r = run(['check', '--tier1', tier1, '--secrets', secrets]);
  check(r.status !== 0, 'node without secret must fail');
  check(/no credential/.test(r.stderr + r.stdout), 'names missing credential');
}
{
  const dir = tmp('orphan-secret');
  const tier1 = writeJSON(path.join(dir, 'tier1.json'), [explicitNode('a')]);
  const secrets = writeJSON(path.join(dir, 'secrets.json'), { a: 'k-a', orphan: 'very-secret-orphan' });
  const r = run(['check', '--tier1', tier1, '--secrets', secrets]);
  check(r.status === 0, 'orphan credential only warns');
  check(/orphan/i.test(r.stderr + r.stdout), 'warns on orphan credential');
  check(!r.stdout.includes('very-secret-orphan') && !r.stderr.includes('very-secret-orphan'), 'never prints credential value');
}
{
  const dir = tmp('bad');
  const tier1 = path.join(dir, 'tier1.json'); fs.writeFileSync(tier1, '{not json');
  const secrets = writeJSON(path.join(dir, 'secrets.json'), {});
  const r = run(['check', '--tier1', tier1, '--secrets', secrets]);
  check(r.status !== 0, 'malformed JSON must fail');
  check(/invalid JSON/.test(r.stderr + r.stdout), 'reports invalid JSON');
}
{
  const secrets = tier1ExampleSecrets();
  const r = run(['show', '--tier1', cfg('tier1-nodes.example.json'), '--secrets', secrets]);
  check(r.status === 0, 'show exits 0');
  check(r.stdout.includes('nvidia-01'), 'lists nvidia-01');
  check(/Tier: 1/.test(r.stdout), 'reports tier 1');
  check(/Credential: configured/.test(r.stdout), 'reports credential configured');
  check(!/secret-nvidia/.test(r.stdout), 'never prints credential values');
}
{
  const dir = tmp('diff');
  const oldTier = writeJSON(path.join(dir, 'old.json'), [explicitNode('a', 'https://a.example.com/v1', 'u1'), explicitNode('b')]);
  const newTier = writeJSON(path.join(dir, 'new.json'), [explicitNode('a', 'https://a.example.com/v1', 'u2'), explicitNode('c')]);
  const oldSec = writeJSON(path.join(dir, 'old-secrets.json'), { a: 'k1', b: 'k2' });
  const newSec = writeJSON(path.join(dir, 'new-secrets.json'), { a: 'k1', c: 'k3' });
  const r = run(['diff', '--old-tier1', oldTier, '--new-tier1', newTier, '--old-secrets', oldSec, '--new-secrets', newSec]);
  check(r.status === 0, 'diff exits 0');
  check(r.stdout.includes('+ c'), 'added node detected'); check(r.stdout.includes('- b'), 'removed node detected'); check(r.stdout.includes('~ a'), 'changed node detected');
  check(/Secrets:/.test(r.stdout), 'secrets section present'); check(!/k1|k2|k3/.test(r.stdout), 'never prints secret values');
}
console.log('config-cli tests passed.');
