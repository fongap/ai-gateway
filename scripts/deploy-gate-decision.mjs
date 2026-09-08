#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Deploy gate decision — the single source of truth for whether a Deploy
// workflow run may touch production. The logic lives here (not inline in
// deploy.yml) so the deployment-workflow contract test can drive every
// scenario directly instead of string-matching shell fragments.
//
// Rules, evaluated in order:
//   Manual workflow_dispatch            -> deploy permitted, BUT it is
//       never a bypass: the deploy workflow's `manual-validate` job runs
//       the full validation suite (validate:deploy + typecheck + strict
//       typecheck + bundle dry-run) before the deploy job may start. Only
//       the manual path re-runs validation, because it is not a
//       high-frequency operation.
//   workflow_run from a fork head repo   -> never deploy.
//   CI run not triggered by a push       -> never deploy. The check
//       is the explicit `workflow_run.event`, never commit-message,
//       timestamp or branch heuristics. Nightly and manual CI runs are
//       test-only.
//   CI conclusion != success             -> never deploy (Production Gate).
//   Triggering commit changed ONLY *.md / docs/** -> skip deploy
//       (reproduces the previous paths-ignore policy).
//   Otherwise (push to main, full CI success, real change) -> deploy.
//
// CLI contract (used by the gate job in deploy.yml): reads EVENT /
// TRIGGER_EVENT / CI_CONCLUSION / HEAD_REPO / THIS_REPO / HEAD_SHA /
// GITHUB_OUTPUT / GITHUB_WORKSPACE from the environment, writes
// `deploy=true|false` to $GITHUB_OUTPUT, prints a human-readable (and
// ::notice-prefixed for blocks) reason, and always exits 0 — a blocked
// deploy is a skip, not a workflow failure.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @param {{
 *   event: string,                 // github.event_name
 *   triggerEvent?: string,         // github.event.workflow_run.event
 *   ciConclusion?: string,         // github.event.workflow_run.conclusion
 *   headRepo?: string,             // github.event.workflow_run.head_repository.full_name
 *   thisRepo?: string,             // github.repository
 *   changedFiles?: string[] | null,// git diff --name-only (null = initial commit / unavailable)
 * }} inputs
 * @returns {{ deploy: boolean, reason: string }}
 */
export function decideDeploy({
  event,
  triggerEvent = '',
  ciConclusion = '',
  headRepo = '',
  thisRepo = '',
  changedFiles = null,
}) {
  // Manual dispatch: allowed at the gate; the manual-validate job is
  // what keeps this from being a silent Production Gate bypass.
  if (event === 'workflow_dispatch') {
    return { deploy: true, reason: 'manual workflow_dispatch — full validation runs in the manual-validate job' };
  }
  // Fork head repositories never deploy.
  if (headRepo !== thisRepo) {
    return { deploy: false, reason: `head repository is a fork (${headRepo || 'unknown'}) — deploy blocked` };
  }
  // Only a CI run triggered by a push may auto-deploy. Scheduled
  // nightly CI and manual CI runs are test-only.
  if (triggerEvent !== 'push') {
    return { deploy: false, reason: `CI run was triggered by '${triggerEvent || 'unknown'}', not a push — deploy blocked (nightly/manual CI is test-only)` };
  }
  // R3 — Production Gate: full CI must have succeeded.
  if (ciConclusion !== 'success') {
    return { deploy: false, reason: `CI conclusion is '${ciConclusion || 'unknown'}' — deploy blocked (Production Gate)` };
  }
  // R4 — markdown/docs-only commits skip the deploy (legacy paths-ignore).
  if (changedFiles !== null) {
    if (changedFiles.length === 0) {
      return { deploy: false, reason: 'no deployable file changes — deploy skipped' };
    }
    const deployable = changedFiles.filter((f) => !/\.md$/.test(f) && !/^docs\//.test(f));
    if (deployable.length === 0) {
      return { deploy: false, reason: 'triggering commit changed only markdown/docs paths — deploy skipped' };
    }
  }
  // R5 — push to main with full CI success and a deployable change.
  return { deploy: true, reason: 'push to main with full CI success — deploy allowed' };
}

// ---- CLI ----------------------------------------------------------------------

function isDirectRun() {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const env = process.env;
  const event = env.EVENT || '';
  const triggerEvent = env.TRIGGER_EVENT || '';
  const ciConclusion = env.CI_CONCLUSION || '';
  const headRepo = env.HEAD_REPO || '';
  const thisRepo = env.THIS_REPO || '';

  // The docs-only check needs the triggering commit; resolve it only when
  // the decision actually reaches that rule (git may be unavailable for
  // manual runs, which never need it).
  let changedFiles = null;
  if (event !== 'workflow_dispatch'
    && headRepo === thisRepo && triggerEvent === 'push' && ciConclusion === 'success') {
    try {
      execFileSync('git', ['config', '--global', '--add', 'safe.directory', env.GITHUB_WORKSPACE || process.cwd()], { stdio: 'ignore' });
      const out = execFileSync('git', ['diff', '--name-only', `${env.HEAD_SHA}^`, env.HEAD_SHA], { encoding: 'utf8' });
      changedFiles = out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      changedFiles = null; // initial commit (or diff unavailable) -> deploy allowed
    }
  }

  const decision = decideDeploy({ event, triggerEvent, ciConclusion, headRepo, thisRepo, changedFiles });
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `deploy=${decision.deploy}\n`);
  }
  const blocked = !decision.deploy;
  const line = blocked ? `::notice::${decision.reason}` : decision.reason;
  console.log(line);
  process.exit(0);
}
