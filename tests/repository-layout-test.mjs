#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function testRefs(text) {
  return [...text.matchAll(/tests\/[A-Za-z0-9._/-]+-test\.mjs/g)].map((match) => match[0]);
}

const scriptsDir = path.join(root, 'scripts');
const srcDir = path.join(root, 'src');
const testsDir = path.join(root, 'tests');
const workflowsDir = path.join(root, '.github', 'workflows');
const testName = /(?:^|[-_.])test(?:[-_.]|\.)/i;

const misplacedScriptTests = walk(scriptsDir)
  .filter((file) => testName.test(path.basename(file)))
  .map((file) => path.relative(root, file));
assert.deepEqual(misplacedScriptTests, [], 'scripts/ must contain tooling, not executable test files');

const misplacedRuntimeTests = walk(srcDir)
  .filter((file) => testName.test(path.basename(file)))
  .map((file) => path.relative(root, file));
assert.deepEqual(misplacedRuntimeTests, [], 'src/ must contain Worker runtime code, not test files');

assert.equal(
  fs.existsSync(path.join(root, '.githooks')),
  false,
  '.githooks must remain local; repository governance is enforced by CI and GitHub workflows',
);

assert.equal(
  fs.existsSync(path.join(root, 'benchmark')),
  false,
  'standalone benchmark/ must remain absent unless a governed benchmark system with stable baselines and thresholds is introduced',
);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const name of ['test:unit', 'test:gate', 'test:all', 'test:integration', 'test:conversion']) {
  const command = pkg.scripts?.[name] || '';
  assert.ok(command, `package.json must define ${name}`);
  assert.doesNotMatch(command, /node\s+scripts\/[^\s]*test/i, `${name} must execute tests from tests/, not scripts/`);
}
assert.equal(pkg.scripts?.bench, undefined, 'package.json must not expose an ungoverned bench command');
assert.equal(pkg.scripts?.['bench:full'], undefined, 'package.json must not expose an ungoverned bench:full command');

const unitRunner = fs.readFileSync(path.join(testsDir, 'run-unit.mjs'), 'utf8');
const unitRefs = new Set(testRefs(unitRunner));
const scriptRefs = new Set(testRefs(Object.values(pkg.scripts || {}).join('\n')));
const registeredRefs = new Set([...unitRefs, ...scriptRefs]);
const discoveredTests = walk(testsDir)
  .filter((file) => /-test\.mjs$/i.test(path.basename(file)))
  .map((file) => path.relative(root, file).replaceAll(path.sep, '/'))
  .sort();
const orphanTests = discoveredTests.filter((file) => !registeredRefs.has(file));
assert.deepEqual(orphanTests, [], 'every *-test.mjs must be registered by run-unit.mjs or a package.json test script');

const gate = pkg.scripts?.['test:gate'] || '';
assert.match(gate, /npm run test:unit/, 'test:gate must include test:unit');
for (const required of [
  'tests/scheduler-stability-test.mjs',
  'tests/integration-test.mjs',
  'tests/stress-test.mjs',
  'tests/codex-contract-test.mjs',
  'tests/claude-contract-test.mjs',
]) {
  assert.ok(testRefs(gate).includes(required), `test:gate must include ${required}`);
  assert.equal(unitRefs.has(required), false, `${required} must not be duplicated in run-unit.mjs and test:gate`);
}

const all = pkg.scripts?.['test:all'] || '';
assert.match(all, /npm run test:gate/, 'test:all must include test:gate');
assert.equal(testRefs(all).length, 0, 'test:all must not duplicate suites already covered by test:gate');

assert.match(pkg.scripts?.['validate:merge'] || '', /npm run test:gate/, 'validate:merge must run the complete deterministic correctness gate');
assert.match(pkg.scripts?.['validate:deploy'] || '', /npm run test:all/, 'validate:deploy must run test:all');

const temporaryTestWorkflows = fs.readdirSync(workflowsDir)
  .filter((name) => /^(?:patch|fix)-.*test.*\.ya?ml$/i.test(name))
  .sort();
assert.deepEqual(temporaryTestWorkflows, [], 'one-shot patch/fix test workflows must not remain on main');

for (const required of [
  'tests/run-unit.mjs',
  'tests/integration-test.mjs',
  'tests/stress-test.mjs',
  'tests/codex-contract-test.mjs',
  'tests/claude-contract-test.mjs',
]) {
  assert.ok(fs.existsSync(path.join(root, required)), `${required} must remain under tests/`);
}

console.log('repository-layout tests passed.');
