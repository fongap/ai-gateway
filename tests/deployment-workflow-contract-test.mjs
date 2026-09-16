#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideDeploy } from '../scripts/deploy-gate-decision.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deploy = readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8').replace(/\r\n/g, '\n');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const bridge = readFileSync(join(root, 'scripts/github-deployment-config.mjs'), 'utf8');
const diagnostics = readFileSync(join(root, 'src/observability/diagnostic-endpoints.ts'), 'utf8');

function pos(text) { return deploy.indexOf(text); }

// Deployment order: migration -> deploy -> verify -> conditional rollback.
const migration = pos('- name: Apply D1 migrations');
const workerDeploy = pos('- name: Deploy Worker');
const verify = pos('- name: Verify deployed gateway');
const rollback = pos('- name: Rollback');
assert.ok(migration >= 0 && workerDeploy > migration, 'D1 migrations must run before Worker deploy');
assert.ok(verify > workerDeploy, 'remote verification must run after Worker deploy');
assert.ok(rollback > verify, 'rollback must follow failed post-deploy verification');
assert.match(deploy, /if: failure\(\) && steps\.deploy\.outcome == 'success'/,
  'rollback must require a completed deploy followed by failure');

// Automatic path is successful push CI on main only; manual path validates itself.
assert.match(deploy, /workflow_run:[\s\S]*workflows: \[CI\][\s\S]*branches: \[main\]/);
assert.match(ci, /validate-merge:/);
assert.match(ci, /validate-deploy:/);
assert.match(ci, /npm run validate:deploy/);
assert.match(deploy, /manual-validate:[\s\S]*npm run validate:deploy[\s\S]*npm run check:deploy/);
assert.match(deploy, /needs: \[gate, manual-validate\]/);

const base = {
  event: 'workflow_run',
  ciConclusion: 'success',
  headRepo: 'fongap/ai-gateway',
  thisRepo: 'fongap/ai-gateway',
  changedFiles: ['src/index.ts'],
};
assert.equal(decideDeploy({ ...base, triggerEvent: 'push' }).deploy, true, 'successful push CI may auto-deploy');
assert.equal(decideDeploy({ ...base, triggerEvent: 'schedule' }).deploy, false, 'scheduled CI is test-only');
assert.equal(decideDeploy({ ...base, triggerEvent: 'workflow_dispatch' }).deploy, false, 'manual CI is test-only');
assert.equal(decideDeploy({ ...base, triggerEvent: 'push', ciConclusion: 'failure' }).deploy, false, 'failed CI must block deploy');
assert.equal(decideDeploy({ ...base, triggerEvent: 'push', headRepo: 'someone/ai-gateway' }).deploy, false, 'fork head must not auto-deploy');
assert.equal(decideDeploy({ ...base, triggerEvent: 'push', changedFiles: ['README.md', 'docs/README.md'] }).deploy, false, 'docs-only change must skip deploy');
assert.equal(decideDeploy({ event: 'workflow_dispatch' }).deploy, true, 'manual Deploy workflow may enter its own validation gate');

// Emergency kill switch and fork opt-in semantics.
assert.match(deploy, /vars\.DEPLOY_ENABLED != 'false'/);
assert.match(deploy, /github\.repository == 'fongap\/ai-gateway'/);
assert.match(deploy, /vars\.DEPLOY_ENABLED == 'true'/);

// Every workflow_run checkout is pinned to the triggering SHA; deploy identity
// is one SHA from validation through runtime verification.
for (const jobName of ['gate:', 'manual-validate:', 'deploy:']) {
  const start = deploy.indexOf(`  ${jobName}`);
  assert.ok(start >= 0, `${jobName} job must exist`);
  const next = deploy.slice(start + 2).search(/^  [A-Za-z][\w-]*:\s*$/m);
  const block = next >= 0 ? deploy.slice(start, start + 2 + next) : deploy.slice(start);
  assert.match(block, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/,
    `${jobName} workflow_run checkout must pin triggering SHA`);
}
assert.match(deploy, /DEPLOYED_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
assert.match(deploy, /GITHUB_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
assert.match(deploy, /health-check --from-env --expected-build "\$DEPLOYED_SHA"/);
assert.match(deploy, /Deployed SHA/);

// The bridge must pass the SHA into the Worker and verify the same value through
// authenticated /health. There is no project release-number endpoint.
assert.match(bridge, /EXTRA_VAR_ALLOW\s*=\s*new Set\(\['GITHUB_SHA'\]\)/);
assert.ok(bridge.includes('`${origin}/health`'), 'remote verifier must call /health');
assert.equal(bridge.includes('`${origin}/version`'), false, 'remote verifier must not call /version');
assert.match(bridge, /healthBody\?\.build !== expectedBuild/);
assert.match(diagnostics, /build:\s*resolveBuildSha\(env\)/);
assert.equal(diagnostics.includes('versionResponse'), false);

// Workflow npm commands must resolve to current package scripts.
for (const wf of [deploy, ci]) {
  for (const match of wf.matchAll(/npm\s+run\s+([A-Za-z0-9_:-]+)/g)) {
    assert.ok(Object.hasOwn(pkg.scripts || {}, match[1]), `workflow references missing npm script ${match[1]}`);
  }
}

console.log('deployment-workflow-contract: all contracts passed');
