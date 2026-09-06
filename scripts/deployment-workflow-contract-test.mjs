#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Deployment Workflow Contract Test.
//
// The deploy-order regressions this suite guards against: a Worker deploy that
// runs before D1 migrations, a production deploy that does not wait for
// full validation, a scheduled/manual CI run that silently redeploys
// production, or a manual deploy that bypasses the Production Gate. YAML
// semantics are not fully parsed — this test makes targeted structural
// assertions on the workflow text and drives the gate DECISION function
// (scripts/deploy-gate-decision.mjs) behaviorally. If the workflows are
// restructured intentionally, update these contracts in the same PR.
//
// Production gate architecture: deploy.yml is triggered by `workflow_run`
// when the CI workflow (ci.yml) completes on main. CI success requires BOTH
// of its jobs — validate-merge (fast gate incl. typecheck + strict + bundle
// dry-run) and validate-deploy (full suite) — so the full validation runs
// exactly once per push and the deploy cannot outrun it. A manual
// workflow_dispatch re-runs the full suite inside the deploy workflow
// (manual-validate job) because a manual run must never be a silent bypass.
//
// Contracts:
//   01  D1 migration step runs BEFORE the Worker deploy step.
//   02  Production deploy is gated on the CI workflow (validate-deploy +
//       validate-merge) succeeding via workflow_run — the automatic path
//       never duplicates full validation inside deploy.yml.
//   03  A migration failure aborts the deploy (no continue-on-error / always()).
//   04  The health check runs AFTER the Worker deploy.
//   05  Rollback only fires when the Worker was deployed and a later step failed.
//   06  Markdown/docs-only commits skip the deploy (gate path check).
//   07  Forks do not auto-deploy without DEPLOY_ENABLED=true, and commits from
//       fork head repositories are never deployed.
//   08  push-triggered CI success on main -> deploy allowed (the ONLY
//       automatic deploy path).
//   09  schedule-triggered (nightly) CI success -> deploy blocked (test-only).
//   10  workflow_dispatch-triggered CI success -> deploy blocked (test-only).
//   11  Manual workflow_dispatch deploys ALWAYS pass through the
//       manual-validate job (full validation inside deploy.yml) — no bypass.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decideDeploy } from './deploy-gate-decision.mjs';

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
const manualValidateJob = jobs['manual-validate'];
if (!deployJob) { console.error('FAIL  deploy job not found in deploy.yml'); process.exit(1); }

function stepIndex(list, namePart) {
  return list.findIndex((s) => s.name.includes(namePart));
}
function stepById(list, id) {
  return list.find((s) => s.id === id);
}

// The REPO constant used for behavioral gate-decision scenarios.
const REPO = 'fongap/ai-gateway';
const PUSH_SUCCESS_BASE = {
  event: 'workflow_run',
  ciConclusion: 'success',
  headRepo: REPO,
  thisRepo: REPO,
  changedFiles: ['src/index.js'],
};

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

  // The deploy job must depend on the gate output (which enforces CI success),
  // and on the manual-validate job with an explicit skip allowance so the
  // automatic path (which skips manual-validate) still deploys. The expression
  // MUST carry always(): when a needed job is skipped, GitHub skips dependent
  // jobs unless the if contains a status-check function that lifts the skip —
  // a plain needs.X.result reference is not evaluated at all in that case.
  const deployWaitsOnGate = deployJob.needs.includes('gate')
    && deployJob.needs.includes('manual-validate')
    && deployJob.if.startsWith('always()')
    && deployJob.if.includes("needs.gate.outputs.deploy == 'true'")
    && deployJob.if.includes("needs.manual-validate.result == 'success'")
    && deployJob.if.includes("needs.manual-validate.result == 'skipped'");

  // The gate decision must treat any CI conclusion other than success as a
  // blocker (behavioral, via the decision function).
  const gateEnforcesCi = !decideDeploy({ ...PUSH_SUCCESS_BASE, triggerEvent: 'push', ciConclusion: 'failure' }).deploy;

  // ci.yml must run the full validate:deploy suite on push to main, so that a
  // successful CI run is exactly the Production Gate.
  const ciRunsFullSuite = /validate-deploy:/.test(ciText)
    && /npm run validate:deploy/.test(ciText)
    && /branches:\s*\n\s*- main/.test(ciText);

  // No duplicated full validation on the AUTOMATIC path: `npm run
  // validate:deploy` may appear only inside the manual-validate job (the
  // manual path's mandatory in-workflow validation), which is explicitly
  // gated on workflow_dispatch.
  const jobsWithValidation = Object.entries(jobs)
    .filter(([, j]) => j.steps.some((s) => (s.run || '').includes('npm run validate:deploy')))
    .map(([name]) => name);
  const validationOnlyInManualJob = jobsWithValidation.length === 1
    && jobsWithValidation[0] === 'manual-validate'
    && Boolean(manualValidateJob)
    && manualValidateJob.if.includes("github.event_name == 'workflow_dispatch'")
    && manualValidateJob.if.includes("needs.gate.outputs.deploy == 'true'");

  check('C02 deploy is gated on CI (validate-deploy + validate-merge) success via workflow_run; full validation is not duplicated on the automatic path',
    triggerOk && deployWaitsOnGate && gateEnforcesCi && ciRunsFullSuite && validationOnlyInManualJob,
    `trigger=${triggerOk} needsGate=${deployWaitsOnGate} gateEnforcesCi=${gateEnforcesCi} ciFull=${ciRunsFullSuite} validationJobs=${JSON.stringify(jobsWithValidation)}`);
}

// ---- Contract 03: migration failure must abort the deploy ---------------------
{
  const mig = stepIndex(deployJob.steps, 'Apply D1 migrations');
  const migStep = deployJob.steps[mig];
  const noSwallow = migStep && !migStep.continueOnError
    && !/always\(\)/.test(migStep.if);
  // The deploy job's if uses always() ONLY as the needs-skip lift prefix
  // (a skipped needed job otherwise skips dependents without evaluation);
  // it must stay conditioned on the gate decision and the manual-validate
  // whitelist, so a failed/cancelled validation or a failed gate can never
  // let the deploy run.
  const deployIfGuarded = deployJob.if.startsWith('always() &&')
    && deployJob.if.includes("needs.gate.outputs.deploy == 'true'")
    && deployJob.if.includes("needs.manual-validate.result == 'success'")
    && deployJob.if.includes("needs.manual-validate.result == 'skipped'");
  // The deploy STEP itself must not run unconditionally.
  const deployStep = stepById(deployJob.steps, 'deploy');
  const deployUnconditional = deployStep && /always\(\)/.test(deployStep.if);
  check('C03 migration failure aborts deploy (no continue-on-error on migration; deploy job if always guarded)',
    noSwallow && deployIfGuarded && !deployUnconditional,
    `migrationStep=${JSON.stringify(migStep && { if: migStep.if, continueOnError: migStep.continueOnError })} deployIf="${deployJob.if}"`);
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
  // Structural: the gate decision lives in the unit-tested decision script and
  // the workflow feeds it the triggering CI event explicitly.
  const decideStep = gateJob && gateJob.steps.find((s) => s.name.includes('Decide deploy eligibility'));
  const gateUsesDecisionScript = Boolean(decideStep)
    && (decideStep.run || '').includes('node scripts/deploy-gate-decision.mjs');
  const gatePassesTriggerEvent = /TRIGGER_EVENT: \$\{\{ github\.event\.workflow_run\.event \}\}/.test(text);

  // Behavioral: docs-only changes are skipped, real changes deploy, and the
  // initial-commit case (no diff available) deploys.
  const docsOnly = decideDeploy({ ...PUSH_SUCCESS_BASE, triggerEvent: 'push', changedFiles: ['README.md', 'docs/operations/deployment.md'] });
  const codeChange = decideDeploy({ ...PUSH_SUCCESS_BASE, triggerEvent: 'push', changedFiles: ['src/index.js', 'README.md'] });
  const initialCommit = decideDeploy({ ...PUSH_SUCCESS_BASE, triggerEvent: 'push', changedFiles: null });
  check('C06 markdown/docs-only changes skip deploy; code changes deploy; initial commit deploys',
    gateUsesDecisionScript && gatePassesTriggerEvent
      && !docsOnly.deploy && codeChange.deploy && initialCommit.deploy,
    `gateUsesScript=${gateUsesDecisionScript} triggerEnv=${gatePassesTriggerEvent} docsOnly=${docsOnly.deploy} code=${codeChange.deploy} initial=${initialCommit.deploy}`);
}

// ---- Contract 07: forks do not auto-deploy ------------------------------------
{
  const okGate = gateJob && gateJob.if.includes("vars.DEPLOY_ENABLED == 'true'")
    && gateJob.if.includes("github.repository == 'fongap/ai-gateway'");
  const okDeploy = deployJob.if.includes("needs.gate.outputs.deploy == 'true'");
  // Behavioral: a fork head repository is never deployed.
  const forkDecision = decideDeploy({ ...PUSH_SUCCESS_BASE, triggerEvent: 'push', headRepo: 'someone/ai-gateway' });
  check('C07 forks require explicit DEPLOY_ENABLED=true; fork head repos never deploy',
    Boolean(okGate && okDeploy) && !forkDecision.deploy,
    `gate if="${gateJob && gateJob.if}" forkDeploy=${forkDecision.deploy}`);
}

// ---- Contract 08: push-triggered CI success on main -> deploy allowed ---------
{
  const decision = decideDeploy({ ...PUSH_SUCCESS_BASE, triggerEvent: 'push' });
  check('C08 push/main/success -> deploy allowed (the only automatic deploy path)',
    decision.deploy === true, `reason="${decision.reason}"`);
}

// ---- Contract 09: nightly (schedule) CI success -> deploy blocked -------------
{
  const decision = decideDeploy({ ...PUSH_SUCCESS_BASE, triggerEvent: 'schedule' });
  check('C09 schedule/success -> deploy blocked (nightly CI is test-only)',
    decision.deploy === false, `reason="${decision.reason}"`);
}

// ---- Contract 10: manually triggered CI success -> deploy blocked -------------
{
  const decision = decideDeploy({ ...PUSH_SUCCESS_BASE, triggerEvent: 'workflow_dispatch' });
  check('C10 workflow_dispatch CI/success -> deploy blocked (manual CI is test-only)',
    decision.deploy === false, `reason="${decision.reason}"`);
}

// ---- Contract 11: manual deploy always passes through full validation ---------
{
  // Behavioral: the gate permits a manual dispatch (so validation can run),
  // but the deploy job may only start after the manual-validate job SUCCEEDED.
  const gateAllowsManual = decideDeploy({ event: 'workflow_dispatch' }).deploy === true;
  const manualValidateExists = Boolean(manualValidateJob);
  const manualValidateGated = manualValidateExists
    && manualValidateJob.needs.includes('gate')
    && manualValidateJob.if.includes("github.event_name == 'workflow_dispatch'");
  const manualValidationSteps = manualValidateExists
    ? manualValidateJob.steps.map((s) => s.run || '').join('\n')
    : '';
  const fullSuiteCovered = manualValidationSteps.includes('npm run validate:deploy')
    && manualValidationSteps.includes('npm run typecheck')
    && manualValidationSteps.includes('npm run typecheck:strict')
    && manualValidationSteps.includes('npm run check:deploy');
  const deployRequiresValidation = deployJob.needs.includes('manual-validate')
    && deployJob.if.startsWith('always()')
    && deployJob.if.includes("needs.manual-validate.result == 'success'")
    && deployJob.if.includes("needs.manual-validate.result == 'skipped'");
  // The old implicit bypass must be gone: no inline gate script may set
  // deploy=true for workflow_dispatch without the validation job.
  const inlineBypassGone = !/EVENT" = "workflow_dispatch"/.test(text);
  check('C11 manual workflow_dispatch -> deploy only after manual-validate full validation (no silent bypass)',
    gateAllowsManual && manualValidateGated && fullSuiteCovered && deployRequiresValidation && inlineBypassGone,
    `manualValidate=${manualValidateExists} gated=${manualValidateGated} fullSuite=${fullSuiteCovered} deployRequires=${deployRequiresValidation} inlineBypassGone=${inlineBypassGone}`);
}

if (failures > 0) {
  console.error(`deployment-workflow-contract: ${failures} contract(s) FAILED`);
  process.exit(1);
}
console.log('deployment-workflow-contract: all contracts passed');
