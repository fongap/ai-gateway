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

const scriptsDir = path.join(root, 'scripts');
const srcDir = path.join(root, 'src');
const testName = /(?:^|[-_.])test(?:[-_.]|\.)/i;

const misplacedScriptTests = walk(scriptsDir)
  .filter((file) => testName.test(path.basename(file)))
  .map((file) => path.relative(root, file));
assert.deepEqual(misplacedScriptTests, [], 'scripts/ must contain tooling, not executable test files');

const misplacedRuntimeTests = walk(srcDir)
  .filter((file) => testName.test(path.basename(file)))
  .map((file) => path.relative(root, file));
assert.deepEqual(misplacedRuntimeTests, [], 'src/ must contain Worker runtime code, not test files');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const name of ['test:unit', 'test:all', 'test:integration', 'test:conversion']) {
  const command = pkg.scripts?.[name] || '';
  assert.ok(command, `package.json must define ${name}`);
  assert.doesNotMatch(command, /node\s+scripts\/[^\s]*test/i, `${name} must execute tests from tests/, not scripts/`);
}

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
