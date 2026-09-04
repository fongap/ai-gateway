#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Unit test runner. Loads and runs every unit-test file in order.
// Each test file is a standalone script that calls process.exit(1) on
// failure, so this runner just chains them and propagates the first
// non-zero exit code. The runner itself does not import any src/ code
// — every test file owns its own imports.
//
// Used by: `npm run test:unit` (from package.json).
// Also wired into `npm run validate:merge`.
//
// To add a new unit test:
//   1. Create scripts/<name>-test.mjs (it must exit non-zero on
//      failure).
//   2. Add the file path to UNIT_TESTS below.
//   3. Run `npm run test:unit` to verify.
//
// Integration / stress / contract tests (integration-test.mjs,
// stress-test.mjs, codex-contract-test.mjs, claude-contract-test.mjs,
// scheduler-stability-test.mjs) are NOT part of the unit suite — they
// are slower and require a fuller environment. They run via
// `npm run test:all` (which chains test:unit first).

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const UNIT_TESTS = [
  'scripts/node-config-shards-test.mjs',
  'scripts/github-deployment-config-test.mjs',
  'scripts/gateway-configuration-test.mjs',
  'scripts/request-reliability-test.mjs',
  'scripts/stream-completion-test.mjs',
  'scripts/token-usage-store-test.mjs',
  'scripts/token-usage-test.mjs',
  'scripts/protocol-matrix-test.mjs',
  'scripts/config-cli-test.mjs',
  'scripts/docs-contract-test.mjs',
  'scripts/provider-discovery-test.mjs',
  'scripts/provider-discovery/ssrf-guard-test.mjs',
  'scripts/model-status-test.mjs',
  'scripts/reliability-performance-test.mjs',
  'scripts/conversion-test.mjs',
  'scripts/config-matrix-test.mjs',
  'scripts/access-keys-test.mjs',
  'scripts/version-check-test.mjs',
];

let failed = 0;
let passed = 0;

for (const rel of UNIT_TESTS) {
  const abs = join(root, rel);
  const result = spawnSync(process.execPath, [abs], { stdio: 'inherit', cwd: root });
  if (result.status === 0) {
    passed++;
  } else {
    failed++;
    console.error(`\n[runner] FAILED: ${rel} (exit ${result.status})\n`);
  }
}

console.log(`\n[test:unit] ${passed}/${UNIT_TESTS.length} suites passed` +
  (failed > 0 ? `, ${failed} FAILED` : ''));

if (failed > 0) process.exit(1);
