#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Deployment Workflow Contract Test.
//
// The deploy-order regressions this suite guards against: a Worker deploy that
// runs before D1 migrations, or a production deploy that does not wait for
// full validation. YAML semantics are not fully parsed — this test makes
// targeted structural assertions on the workflow text (jobs, step order, step
// conditions), which is enough to pin the release-safety facts and prevent
// silent drift. If the workflows are restructured intentionally, update these
// contracts in the same PR.
//
// Production gate architecture: deploy.yml is triggered by `workflow_run`
// when the CI workflow (ci.yml) completes on main. CI success requires BOTH
// of its jobs — validate-merge (fast gate incl. typecheck + strict + bundle
// dry-run) and validate-deploy (full suite) — so the full validation runs
// exactly once per push and the deploy cannot outrun it.
//
// Contracts:
//   01  D1 migration step runs BEFORE the Worker deploy step.
//   02  Production deploy is gated on the CI workflow (validate-deploy +
//       validate-merge) succeeding via workflow_run — no duplicated
//       full-validation job inside deploy.yml.
//   03  A migration failure aborts the deploy (no continue-on-error / always()).
//   04  The health check runs AFTER the Worker deploy.
//   05  Rollback only fires when the Worker was deployed and a later step failed.
//   06  Markdown/docs-only commits skip the deploy (gate job path check).
//   07  Forks do not auto-deploy without DEPLOY_ENABLED=true, and commits from
//       fork head repositories are never deployed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const workflowPath = join(root, '.github', 'workflows', 'deploy.yml');
const ciPath = join(root, '.github', 'workflows', 'ci.yml');

const text = readFileSync(workflowPath, 'utf8');
const ciText = readFileSync(ciPath, 'utf8');

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
    // Continuation lines of a multi-line `run: |` block sit deeper than the
    // property indentation (8 spaces); capture them so gate-script logic is
    // assertable.
    if (currentStep._inRun && /^ {10,}\S/.test(line)) {
      currentStep.run += '\n' + line.trim();
      continue;
    }
    const prop = line.match(/^        (name|if|run|uses|id):\s*(.*)$/);
    if (prop) {
      const key = prop[1] === 'name' || prop[1] === 'if' || prop[1] === 'run' || prop[1] === 'uses' || prop[1] === 'id' ? prop[1] : null;
      if (key === 'run') {
        currentStep._inRun = prop[2] === '|' || prop[2] === '>-' || prop[2] === '>-';
        currentStep.run = currentStep._inRun ? '' : prop[2];
      } else if (key === 'run' && currentStep.run) currentStep.run += '\n' + prop[2];
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
const gateJob = jobs.gate;
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

// ---- Contract 02: production deploy gated on the CI workflow ------------------
{
  // deploy.yml must trigger on CI workflow_run completion for main, completed only.
  const triggerOk = /workflow_run:\s*\n\s*workflows:\s*\[CI\]\s*\n\s*types:\s*\[completed\]\s*\n\s*branches:\s*\[main\]/.test(text);

  // The deploy job must depend on the gate output (which enforces CI success).
  const deployWaitsOnGate = deployJob.needs.includes('gate')
    && deployJob.if.includes("needs.gate.outputs.deploy == 'true'");

  // The gate must treat any CI conclusion other than success as a blocker.
  const gateEnforcesCi = Boolean(gateJob)
    && /CI_CONCLUSION["']?\s*!=\s*["']?success/.test(gateJob.steps.map((s) => s.run).join('\n'));

  // ci.yml must run the full validate:deploy suite on push to main, so that a
  // successful CI run is exactly the Production Gate.
  const ciRunsFullSuite = /validate-deploy:/.test(ciText)
    && /npm run validate:deploy/.test(ciText)
    && /branches:\s*\n\s*- main/.test(ciText);

  // No duplicated full validation inside deploy.yml (single execution per push).
  const noDuplication = !/npm run validate:deploy/.test(text);

  check('C02 deploy is gated on CI (validate-deploy + validate-merge) success via workflow_run',
    triggerOk && deployWaitsOnGate && gateEnforcesCi && ciRunsFullSuite && noDuplication,
    `trigger=${triggerOk} needsGate=${deployWaitsOnGate} gateEnforcesCi=${gateEnforcesCi} ciFull=${ciRunsFullSuite} noDup=${noDuplication}`);
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

// ---- Contract 06: markdown/docs-only changes skip deploy ----------------------
{
  const gateRun = gateJob ? gateJob.steps.map((s) => s.run).join('\n') : '';
  const ok = gateRun.includes("-e '\\.md$'")
    && gateRun.includes("-e '^docs/'")
    && gateRun.includes('deploy=false');
  check('C06 markdown/docs-only changes skip deploy (gate path check)', ok,
    'gate job must filter *.md and docs/** and set deploy=false');
}

// ---- Contract 07: forks do not auto-deploy ------------------------------------
{
  const okGate = gateJob && gateJob.if.includes("vars.DEPLOY_ENABLED == 'true'")
    && gateJob.if.includes("github.repository == 'fongap/ai-gateway'");
  const okDeploy = deployJob.if.includes("needs.gate.outputs.deploy == 'true'");
  const headRepoCheck = gateJob && gateJob.steps.map((s) => s.run).join('\n')
    .includes('HEAD_REPO" != "$THIS_REPO"');
  check('C07 forks require explicit DEPLOY_ENABLED=true; fork head repos never deploy',
    Boolean(okGate && okDeploy && headRepoCheck),
    `gate if="${gateJob && gateJob.if}"`);
}

if (failures > 0) {
  console.error(`deployment-workflow-contract: ${failures} contract(s) FAILED`);
  process.exit(1);
}
console.log('deployment-workflow-contract: all contracts passed');
