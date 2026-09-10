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
//   12  Every `npm run <script>` referenced from a workflow file resolves
//       to a script that actually exists in package.json. Catches dead
//       references (e.g. the historic `typecheck:strict` step).
//   13  Every workflow_run job that runs validation or deploys code
//       explicitly checkouts `github.event.workflow_run.head_sha`. Relying
//       on the default `GITHUB_SHA` is not auditable from the workflow
//       YAML alone and can drift if a newer commit lands while CI is
//       running. Validated SHA == deployed SHA.
//   14  The deploy job captures the deployed SHA in `DEPLOYED_SHA` and the
//       Deployment summary step writes it as a top-level field, so the
//       deployment metadata SHA is auditable from the workflow run log.
//   15  The rollback step (when it fires) records the SAME SHA that the
//       deploy step recorded, so the rolled-back-from SHA is consistent
//       with the metadata.
//   16  The deploy job injects `GITHUB_SHA` as a Worker env so the
//       runtime can expose the deployment identity on `GET /version`
//       (the `build` field). Validated SHA == deployed SHA ==
//       Worker build identity.
//   17  The deployment bridge allow-list includes `GITHUB_SHA` so the
//       injected env var is actually plumbed through to the Worker
//       vars map; otherwise the runtime would never see it.
//   18  `versionResponse` (or its source in diagnostic-endpoints.ts)
//       exposes a `build` field derived from `env.GITHUB_SHA` so the
//       deployment identity is observable from outside.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decideDeploy } from '../scripts/deploy-gate-decision.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const workflowPath = join(root, '.github', 'workflows', 'deploy.yml');
const ciPath = join(root, '.github', 'workflows', 'ci.yml');

const text = readFileSync(workflowPath, 'utf8');
const ciText = readFileSync(ciPath, 'utf8');

function parseWorkflow(source) {
  const lines = source.split('\n');
  const jobs = {};
  let currentJob = null;
  let inJobs = false;
  let currentStep = null;

  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    const jobMatch = line.match(/^  ([A-Za-z][\w-]*):\s*$/);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs[currentJob] = { needs: [], if: '', steps: [] };
      currentStep = null;
      continue;
    }
    if (!currentJob) continue;
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
    const stepStart = line.match(/^      - (.+?)\s*$/);
    if (stepStart) {
      currentStep = { name: '', if: '', run: '', uses: '', id: '', continueOnError: false };
      const kv = stepStart[1].match(/^(name|id):\s*(.+?)\s*$/);
      if (kv) currentStep[kv[1]] = kv[2];
      jobs[currentJob].steps.push(currentStep);
      continue;
    }
    if (!currentStep) continue;
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

const REPO = 'fongap/ai-gateway';
const PUSH_SUCCESS_BASE = {
  event: 'workflow_run',
  ciConclusion: 'success',
  headRepo: REPO,
  thisRepo: REPO,
  changedFiles: ['src/index.ts'],
};

{
  const mig = stepIndex(deployJob.steps, 'Apply D1 migrations');
  const dep = stepIndex(deployJob.steps, 'Deploy Worker');
  check('C01 D1 migration runs before Worker deploy', mig !== -1 && dep !== -1 && mig < dep,
    `migration index=${mig}, deploy index=${dep}`);
}

{
  const triggerOk = /workflow_run:\s*\n\s*workflows:\s*\[CI\]\s*\n\s*types:\s*\[completed\]\s*\n\s*branches:\s*\[main\]/.test(text);
  const deployWaitsOnGate = deployJob.needs.includes('gate')
    && deployJob.needs.includes('manual-validate')
    && deployJob.if.startsWith('always()')
    && deployJob.if.includes("needs.gate.outputs.deploy == 'true'")
    && deployJob.if.includes("needs.manual-validate.result == 'success'")
    && deployJob.if.includes("needs.manual-validate.result == 'skipped'");
  const gateEnforcesCi = !decideDeploy({ ...PUSH_SUCCESS_BASE, triggerEvent: 'push', ciConclusion: 'failure' }).deploy;
  const ciRunsFullSuite = /validate-deploy:/.test(ciText)
    && /npm run validate:deploy/.test(ciText)
    && /branches:\s*\n\s*- main/.test(ciText);
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

{
  const mig = stepIndex(deployJob.steps, 'Apply D1 migrations');
  const migStep = deployJob.steps[mig];
  const noSwallow = migStep && !migStep.continueOnError
    && !/always\(\)/.test(migStep.if);
  const deployIfGuarded = deployJob.if.startsWith('always() &&')
    && deployJob.if.includes("needs.gate.outputs.deploy == 'true'")
    && deployJob.if.includes("needs.manual-validate.result == 'success'")
    && deployJob.if.includes("needs.manual-validate.result == 'skipped'");
  const deployStep = stepById(deployJob.steps, 'deploy');
  const deployUnconditional = deployStep && /always\(\)/.test(deployStep.if);
  check('C03 migration failure aborts deploy (no continue-on-error on migration; deploy job if always guarded)',
    noSwallow && deployIfGuarded && !deployUnconditional,
    `migrationStep=${JSON.stringify(migStep && { if: migStep.if, continueOnError: migStep.continueOnError })} deployIf="${deployJob.if}"`);
}

{
  const dep = stepIndex(deployJob.steps, 'Deploy Worker');
  const health = stepIndex(deployJob.steps, 'Verify deployed gateway');
  check('C04 health check runs after Worker deploy', dep !== -1 && health > dep,
    `deploy index=${dep}, health index=${health}`);
}

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

{
  const decideStep = gateJob && gateJob.steps.find((s) => s.name.includes('Decide deploy eligibility'));
  const gateUsesDecisionScript = Boolean(decideStep)
    && (decideStep.run || '').includes('node scripts/deploy-gate-decision.mjs');
  const gatePassesTriggerEvent = /TRIGGER_EVENT: \$\{\{ github\.event\.workflow_run\.event \}\}/.test(text);
  const docsOnly = decideDeploy({ ...PUSH_SUCCESS_BASE, triggerEvent: 'push', changedFiles: ['README.md', 'docs/operations/deployment.md'] });
  const codeChange = decideDeploy({ ...PUSH_SUCCESS_BASE, triggerEvent: 'push', changedFiles: ['src/index.ts', 'README.md'] });
  const initialCommit = decideDeploy({ ...PUSH_SUCCESS_BASE, triggerEvent: 'push', changedFiles: null });
  check('C06 markdown/docs-only changes skip deploy; code changes deploy; initial commit deploys',
    gateUsesDecisionScript && gatePassesTriggerEvent
      && !docsOnly.deploy && codeChange.deploy && initialCommit.deploy,
    `gateUsesScript=${gateUsesDecisionScript} triggerEnv=${gatePassesTriggerEvent} docsOnly=${docsOnly.deploy} code=${codeChange.deploy} initial=${initialCommit.deploy}`);
}

{
  const okGate = gateJob && gateJob.if.includes("vars.DEPLOY_ENABLED == 'true'")
    && gateJob.if.includes("github.repository == 'fongap/ai-gateway'");
  const okDeploy = deployJob.if.includes("needs.gate.outputs.deploy == 'true'");
  const forkDecision = decideDeploy({ ...PUSH_SUCCESS_BASE, triggerEvent: 'push', headRepo: 'someone/ai-gateway' });
  check('C07 forks require explicit DEPLOY_ENABLED=true; fork head repos never deploy',
    Boolean(okGate && okDeploy) && !forkDecision.deploy,
    `gate if="${gateJob && gateJob.if}" forkDeploy=${forkDecision.deploy}`);
}

{
  const decision = decideDeploy({ ...PUSH_SUCCESS_BASE, triggerEvent: 'push' });
  check('C08 push/main/success -> deploy allowed (the only automatic deploy path)',
    decision.deploy === true, `reason="${decision.reason}"`);
}

{
  const decision = decideDeploy({ ...PUSH_SUCCESS_BASE, triggerEvent: 'schedule' });
  check('C09 schedule/success -> deploy blocked (nightly CI is test-only)',
    decision.deploy === false, `reason="${decision.reason}"`);
}

{
  const decision = decideDeploy({ ...PUSH_SUCCESS_BASE, triggerEvent: 'workflow_dispatch' });
  check('C10 workflow_dispatch CI/success -> deploy blocked (manual CI is test-only)',
    decision.deploy === false, `reason="${decision.reason}"`);
}

{
  const gateAllowsManual = decideDeploy({ event: 'workflow_dispatch' }).deploy === true;
  const manualValidateExists = Boolean(manualValidateJob);
  const manualValidateGated = manualValidateExists
    && manualValidateJob.needs.includes('gate')
    && manualValidateJob.if.includes("github.event_name == 'workflow_dispatch'");
  const manualValidationSteps = manualValidateExists
    ? manualValidateJob.steps.map((s) => s.run || '').join('\n')
    : '';
  const fullSuiteCovered = manualValidationSteps.includes('npm run validate:deploy')
    && manualValidationSteps.includes('npm run check:deploy');
  const noRemovedTypecheckSteps = !manualValidationSteps.includes('npm run typecheck:strict')
    && !/^\s*npm run typecheck\s*$/m.test(manualValidationSteps);
  const deployRequiresValidation = deployJob.needs.includes('manual-validate')
    && deployJob.if.startsWith('always()')
    && deployJob.if.includes("needs.manual-validate.result == 'success'")
    && deployJob.if.includes("needs.manual-validate.result == 'skipped'");
  const inlineBypassGone = !/EVENT" = "workflow_dispatch"/.test(text);
  check('C11 manual workflow_dispatch -> deploy only after manual-validate runs the unified validate:deploy + check:deploy suite (no silent bypass, no scattered typecheck steps)',
    gateAllowsManual && manualValidateGated && fullSuiteCovered && noRemovedTypecheckSteps && deployRequiresValidation && inlineBypassGone,
    `manualValidate=${manualValidateExists} gated=${manualValidateGated} fullSuite=${fullSuiteCovered} noRemovedTypecheckSteps=${noRemovedTypecheckSteps} deployRequires=${deployRequiresValidation} inlineBypassGone=${inlineBypassGone}`);
}

{
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const scripts = packageJson.scripts || {};
  const referenced = new Set();
  const wfFiles = [
    join(root, '.github', 'workflows', 'deploy.yml'),
    join(root, '.github', 'workflows', 'ci.yml'),
    join(root, '.github', 'workflows', 'provider-discovery.yml'),
  ];
  const npmRunRe = /npm\s+run\s+([A-Za-z0-9_:-]+)/g;
  for (const wf of wfFiles) {
    let body;
    try { body = readFileSync(wf, 'utf8'); } catch { continue; }
    let m;
    while ((m = npmRunRe.exec(body)) !== null) {
      referenced.add(m[1]);
    }
  }
  const missing = [...referenced].filter((s) => !Object.prototype.hasOwnProperty.call(scripts, s));
  check('C12 every `npm run <script>` referenced from a workflow exists in package.json',
    missing.length === 0,
    `missing scripts: ${JSON.stringify(missing)} (referenced: ${[...referenced].sort().join(', ')})`);
}

{
  const workflowRunJobs = ['gate', 'manual-validate', 'deploy'];
  const pinRe = /ref:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/;
  const perJob = {};
  for (const name of workflowRunJobs) {
    const block = extractJobTextBlock(text, name);
    if (!block) { perJob[name] = 'missing'; continue; }
    perJob[name] = pinRe.test(block) ? 'pinned' : 'unpinned';
  }
  const allPinned = workflowRunJobs.every((n) => perJob[n] === 'pinned');
  check('C13 every workflow_run job (gate, manual-validate, deploy) explicitly checkouts github.event.workflow_run.head_sha (validated SHA = deployed SHA)',
    allPinned,
    `perJob=${JSON.stringify(perJob)}`);
}

{
  const summaryStep = deployJob.steps.find((s) => (s.name || '').includes('Deployment summary'));
  const shaCaptured = /DEPLOYED_SHA:/.test(text);
  const summaryRecordsSha = summaryStep
    && /DEPLOYED_SHA/.test(summaryStep.run || '')
    && /Deployed SHA/.test(summaryStep.run || '');
  check('C14 deployment summary records the deployed SHA (DEPLOYED_SHA env, single source of truth)',
    Boolean(shaCaptured && summaryRecordsSha),
    `summaryStep=${Boolean(summaryStep)} shaCaptured=${shaCaptured} summaryRecordsSha=${summaryRecordsSha}`);
}

{
  const rollback = deployJob.steps.find((s) => (s.name || '').includes('Rollback'));
  const recordsSameSha = rollback
    && /\$\{DEPLOYED_SHA\}/.test(rollback.run || '');
  check('C15 rollback records the same SHA as the deploy (DEPLOYED_SHA in rollback step)',
    Boolean(recordsSameSha),
    `rollback if="${rollback && rollback.if}" rollbackRun="${(rollback && rollback.run) || ''}"`);
}

{
  const deployJobBlock = extractJobTextBlock(text, 'deploy');
  const injectsGithubSha = /GITHUB_SHA:\s*\$\{\{[^}]*head_sha[^}]*\}\}/.test(deployJobBlock)
    || /GITHUB_SHA:\s*\$\{\{[^}]*DEPLOYED_SHA[^}]*\}\}/.test(deployJobBlock)
    || /GITHUB_SHA:\s*\$\{\{[^}]*sha[^}]*\}\}/.test(deployJobBlock);
  check('C16 deploy job injects GITHUB_SHA as a Worker env (deployment identity visible to runtime)',
    injectsGithubSha,
    `deployJobBlock matched=${injectsGithubSha}`);
}

{
  const bridgeSource = readFileSync(join(root, 'scripts', 'github-deployment-config.mjs'), 'utf8');
  const allowLine = bridgeSource.match(/EXTRA_VAR_ALLOW\s*=\s*new Set\(\[([^\]]+)\]\)/);
  const allowNames = allowLine
    ? [...allowLine[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    : [];
  check('C17 deployment bridge allow-list includes GITHUB_SHA (plumbs identity to runtime vars)',
    allowNames.includes('GITHUB_SHA'),
    `allowNames=${JSON.stringify(allowNames)}`);
}

{
  const diagSource = readFileSync(join(root, 'src', 'observability', 'diagnostic-endpoints.ts'), 'utf8');
  const versionBlock = extractFunctionBlock(diagSource, 'versionResponse');
  const hasBuildField = /build\s*:/.test(versionBlock);
  const hasBuildResolver = /resolveBuildSha\(/.test(versionBlock)
    || /env\?\.GITHUB_SHA/.test(versionBlock);
  check('C18 versionResponse exposes a `build` field derived from env.GITHUB_SHA (deployment identity observable)',
    hasBuildField && hasBuildResolver,
    `hasBuildField=${hasBuildField} hasBuildResolver=${hasBuildResolver}`);
}

function extractJobTextBlock(source, jobName) {
  const lines = source.split('\n');
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && new RegExp(`^  ${jobName}:\\s*$`).test(lines[i])) start = i;
    else if (start !== -1 && i > start && /^  [A-Za-z][\w-]*:\s*$/.test(lines[i])) { end = i; break; }
  }
  if (start === -1) return '';
  return lines.slice(start, end).join('\n');
}

function extractFunctionBlock(source, functionName) {
  const re = new RegExp(`export\\s+function\\s+${functionName}\\s*\\(`, 'g');
  const startMatch = re.exec(source);
  if (!startMatch) return '';
  const start = startMatch.index;
  let depth = 0;
  let inString = null;
  let inComment = false;
  let i = source.indexOf('{', start);
  if (i === -1) return '';
  depth = 1;
  for (let j = i + 1; j < source.length; j++) {
    const ch = source[j];
    const prev = source[j - 1];
    if (inComment) { if (ch === '\n') inComment = false; continue; }
    if (inString) {
      if (ch === inString && prev !== '\\') inString = null;
      continue;
    }
    if (ch === '/' && source[j + 1] === '/') { inComment = true; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  return source.slice(start);
}

if (failures > 0) {
  console.error(`deployment-workflow-contract: ${failures} contract(s) FAILED`);
  process.exit(1);
}
console.log('deployment-workflow-contract: all contracts passed');
