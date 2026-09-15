#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const deploy = readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8');

// The gate condition is intentionally one line. Find it by the three semantic
// clauses we care about instead of trying to parse surrounding YAML/comments.
const gateIf = deploy.split(/\r?\n/).find((line) =>
  line.includes("vars.DEPLOY_ENABLED != 'false'")
  && line.includes("github.repository == 'fongap/ai-gateway'")
  && line.includes("vars.DEPLOY_ENABLED == 'true'"),
)?.trim() || '';

assert.ok(
  gateIf.includes("vars.DEPLOY_ENABLED != 'false'"),
  'original-repository auto deploy must have an explicit DEPLOY_ENABLED=false kill switch',
);
assert.ok(
  gateIf.includes("github.repository == 'fongap/ai-gateway'"),
  'original repository must still auto-deploy by default when the kill switch is unset',
);
assert.ok(
  gateIf.includes("vars.DEPLOY_ENABLED == 'true'"),
  'fork deployments must remain explicit opt-in via DEPLOY_ENABLED=true',
);
assert.match(
  gateIf,
  /DEPLOY_ENABLED != 'false'.*\(github\.repository == 'fongap\/ai-gateway' \|\| vars\.DEPLOY_ENABLED == 'true'\)/,
  'kill switch must guard both the original-repo default and fork opt-in branches',
);

console.log('deploy kill-switch contract tests passed.');
