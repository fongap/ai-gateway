#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Deployment Workflow Contract Test.
//
// The deploy-order regression this suite guards against: a Worker deploy that
// runs before D1 migrations, or a production deploy that does not wait for
// full validation. YAML semantics are not fully parsed — this test makes
// targeted structural assertions on the workflow text (jobs, step order,
// step conditions), which is enough to pin the release-safety facts and
// prevent silent drift. If the workflow is restructured intentionally,
// update these contracts in the same PR.
//
// Contracts:
//   01  D1 migration step runs BEFORE the Worker deploy step.
//   02  The deploy job depends (`needs:`) on a job running full validate:deploy.
//   03  A migration failure aborts the deploy (no continue-on-error / always()).
//   04  The health check runs AFTER the Worker deploy.
//   05  Rollback only fires when the Worker was deployed and a later step failed.
//   06  Markdown-only changes skip the production deploy (existing paths-ignore policy).
//   07  Forks do not auto-deploy without DEPLOY_ENABLED=true.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const workflowPath = join(root, '.github', 'workflows', 'deploy.yml');

const text = readFileSync(workflowPath, 'utf8');

// ---- Minimal structural parse ------------------------------------------------
// Extract jobs and their ordered steps from the workflow text. Indentation in
// this repository's workflows is stable (2 spaces per level), so a line-based
// scan is sufficient and dependency-free.

function parseWorkflow(source) {
  const lines = source.split('\n');
  const jobs = {};
  let currentJob = null;
  let inJobs = false;
  let currentStep = null;

  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    // A job key is exactly two spaces of indentation: "  <name>:"
    const jobMatch = line.match(/^  ([A-Za-z][\w-]*):\s*$/);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs[currentJob] = { needs: [], if: '', steps: [] };
      currentStep = null;
      continue;
    }
    if (!currentJob) continue;
    // Job-level attributes are indented four spaces.
    const needsMatch = line.match(/^    needs:\s*(.+?)\s*$/);
    if (needsMatch) {
      jobs[currentJob].needs = needsMatch[1]
        .replace(/[[\]]/g, '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      continue;
    }
    const jobIfMatch = line.match(/^    if:\s*(.+?)\s*$/);
    if (jobIfMatch && !currentStep) {
      jobs[currentJob].if += jobIfMatch[1];
      continue;
    }
    // A step starts at six spaces + "- ".
    const stepStart = line.match(/^      - (.+?)\s*$/);
    if (stepStart) {
      currentStep = { name: '', if: '', run: '', uses: '', id: '', continueOnError: false };
      const kv = stepStart[1].match(/^(name|id):\s*(.+?)\s*$/);
      if (kv) currentStep[kv[1]] = kv[2];
      jobs[currentJob].steps.push(currentStep);
      continue;
    }
    if (!currentStep) continue;
    const prop = line.match(/^        (name|if|run|uses|id):\s*(.*)$/);
    if (prop) {
      const key = prop[1] === 'name' || prop[1] === 'if' || prop[1] === 'run' || prop[1] === 'uses' || prop[1] === 'id' ? prop[1] : null;
      if (key === 'run' && currentStep.run) currentStep.run += '\n' + prop[2];
      else if (key) currentStep[key] = prop[2];
      continue;
    }
    if (line.match(/^        continue-on-error:\s*true/)) currentStep.continueOnError = true;
  }
  return jobs;
}

const jobs = parseWorkflow(text);

// ---- Helpers -----------------------------------------------------------------
let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const deployJob = jobs.deploy;
const validateJob = jobs.validate;
if (!deployJob) { console.error('FAIL  deploy job not found in deploy.yml'); process.exit(1); }

function stepIndex(list, namePart) {
  return list.findIndex((s) => s.name.includes(namePart));
}
function stepById(list, id) {
  return list.find((s) => s.id === id);
}

// ---- Contract 01: migration before Worker deploy ------------------------------
{
  const mig = stepIndex(deployJob.steps, 'Apply D1 migrations');
  const dep = stepIndex(deployJob.steps, 'Deploy Worker');
  check('C01 D1 migration runs before Worker deploy', mig !== -1 && dep !== -1 && mig < dep,
    `migration index=${mig}, deploy index=${dep}`);
}

// ---- Contract 02: production deploy depends on full validation ----------------
{
  const validateRunsFullSuite = validateJob
    && validateJob.steps.some((s) => s.run.includes('npm run validate:deploy'));
  const deployWaits = deployJob.needs.includes('validate');
  check('C02 deploy job needs a job running npm run validate:deploy',
    validateRunsFullSuite && deployWaits,
    `needs=${JSON.stringify(deployJob.needs)}, validate:deploy present=${validateRunsFullSuite}`);
}

// ---- Contract 03: migration failure must abort the deploy ---------------------
{
  const mig = stepIndex(deployJob.steps, 'Apply D1 migrations');
  const migStep = deployJob.steps[mig];
  const noSwallow = migStep && !migStep.continueOnError
    && !/always\(\)/.test(migStep.if)
    && !/always\(\)/.test(deployJob.if);
  // The deploy step itself must not run unconditionally after failure.
  const deployStep = stepById(deployJob.steps, 'deploy');
  const deployUnconditional = deployStep && /always\(\)/.test(deployStep.if);
  check('C03 migration failure aborts deploy (no continue-on-error/always())',
    noSwallow && !deployUnconditional,
    `migrationStep=${JSON.stringify(migStep && { if: migStep.if, continueOnError: migStep.continueOnError })}`);
}

// ---- Contract 04: health check after Worker deploy ----------------------------
{
  const dep = stepIndex(deployJob.steps, 'Deploy Worker');
  const health = stepIndex(deployJob.steps, 'Verify deployed gateway');
  check('C04 health check runs after Worker deploy', dep !== -1 && health > dep,
    `deploy index=${dep}, health index=${health}`);
}

// ---- Contract 05: rollback semantics ------------------------------------------
{
  const dep = stepIndex(deployJob.steps, 'Deploy Worker');
  const rollback = deployJob.steps.find((s) => s.name.includes('Rollback'));
  const okCond = rollback
    && /failure\(\)/.test(rollback.if)
    && /steps\.deploy\.outcome == 'success'/.test(rollback.if);
  const afterDeploy = rollback && dep !== -1
    && deployJob.steps.indexOf(rollback) > dep;
  const deploysBehind = stepById(deployJob.steps, 'deploy') !== undefined;
  check('C05 rollback only when deployed and a later step failed',
    Boolean(okCond && afterDeploy && deploysBehind),
    `rollback if="${rollback && rollback.if}"`);
}

// ---- Contract 06: markdown-only changes skip deploy ---------------------------
{
  const pushBlock = text.match(/on:\s*\n  push:\s*\n((?:.+\n)+?)(?=  workflow_dispatch:|  pull_request:|permissions:)/);
  const ok = Boolean(pushBlock)
    && pushBlock[1].includes("'**.md'")
    && pushBlock[1].includes("'docs/**'");
  check('C06 markdown-only changes skip production deploy (paths-ignore)', ok);
}

// ---- Contract 07: forks do not auto-deploy ------------------------------------
{
  const ok = deployJob.if.includes("vars.DEPLOY_ENABLED == 'true'")
    && deployJob.if.includes("github.repository == 'fongap/ai-gateway'");
  check('C07 forks require explicit DEPLOY_ENABLED=true', ok, `deploy job if="${deployJob.if}"`);
}

if (failures > 0) {
  console.error(`deployment-workflow-contract: ${failures} contract(s) FAILED`);
  process.exit(1);
}
console.log('deployment-workflow-contract: all contracts passed');
