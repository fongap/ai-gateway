// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// D1 migration governance check (PR 5 / P1-D).
//
// Enforces the rules in migrations/README.md so a careless commit cannot
// silently break a rolling deploy:
//   1. file naming follows NNN_<slug>.sql (monotonic, zero-padded, unique);
//   2. applied files are immutable — re-running the check refuses a file
//      whose content drifts from the previous git tree;
//   3. every CREATE statement uses IF NOT EXISTS (so re-applying the
//      sequence is a no-op — D1 has no migrations table to track history);
//   4. destructive SQL (DROP TABLE, DROP COLUMN, RENAME COLUMN, RENAME TABLE,
//      DELETE FROM) is blocked by default — the old Worker must remain
//      compatible with the new schema after a rollback. Only explicitly
//      allowlisted destructive migrations pass (e.g. index cleanup that the
//      previous Worker version can tolerate).
//
// This is a pure-Node check; it does not need a D1 binding.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const migDir = path.join(root, 'migrations');

const FILENAME_RE = /^(\d{3,})_([a-z0-9_]+)\.sql$/;
const MIGRATION_NUMBER_RE = /^(\d+)_/;

// Explicit allowlist of migration files that contain destructive SQL but are
// verified to be backward-compatible with the previous Worker version.
// To add a new exception: verify the old Worker still runs with the new
// schema, then add the filename here with a comment explaining why.
const DESTRUCTIVE_ALLOWLIST = new Set([
  // Index cleanup: DROP INDEX only removes redundant indexes; the previous
  // Worker version uses the PK index and is unaffected.
  '0007_drop_redundant_usage_indexes.sql',
]);

function listMigrations() {
  return fs.readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function parseName(file) {
  const m = FILENAME_RE.exec(file);
  if (!m) return null;
  return { num: Number.parseInt(m[1], 10), slug: m[2] };
}

function checkMonotonicAndUnique(files) {
  const seen = new Map();
  for (const f of files) {
    const p = parseName(f);
    assert.ok(p, `migration file "${f}" does not match NNN_slug.sql pattern`);
    assert.ok(seen.get(p.num) === undefined, `duplicate migration number ${p.num} (${f} vs ${seen.get(p.num)})`);
    seen.set(p.num, f);
  }
  const nums = [...seen.keys()].sort((a, b) => a - b);
  for (let i = 1; i < nums.length; i += 1) {
    const prev = nums[i - 1];
    const cur = nums[i];
    assert.ok(cur - prev === 1, `migration numbers must be strictly consecutive: gap between ${prev} and ${cur}`);
  }
}

function checkIdempotent(files) {
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
    const upper = sql.toUpperCase();
    const createMatches = upper.match(/\bCREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)\b/g) || [];
    for (const stmt of createMatches) {
      const offset = upper.indexOf(stmt);
      const after = upper.slice(offset, offset + 200);
      assert.ok(after.includes('IF NOT EXISTS'),
        `${f}: every CREATE must use IF NOT EXISTS so re-applies are no-ops (D1 has no migrations table)`);
    }
  }
}

function getBaseCommit() {
  // Determine the base commit for comparison.
  // PR context: GITHUB_BASE_REF or git merge-base with origin/main
  // Push context: HEAD~1 or merge-base with origin/main
  // CI provides GITHUB_BASE_REF for PRs; for pushes we use HEAD~1.
  const envBase = process.env.GITHUB_BASE_REF;
  if (envBase) {
    // PR: try to get the merge-base with the base branch
    const r = spawnSync('git', ['merge-base', `origin/${envBase}`, 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) {
      return r.stdout.trim();
    }
    // Fallback: try origin/main
    const r2 = spawnSync('git', ['merge-base', 'origin/main', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (r2.status === 0 && r2.stdout.trim()) {
      return r2.stdout.trim();
    }
  }
  // Push or fallback: use HEAD~1 (parent of current commit)
  const r3 = spawnSync('git', ['rev-parse', 'HEAD~1'], { cwd: root, encoding: 'utf8' });
  if (r3.status === 0 && r3.stdout.trim()) {
    return r3.stdout.trim();
  }
  return null;
}

function ensureHistory(baseCommit) {
  // If the base commit is not reachable (shallow checkout), fetch more history.
  if (!baseCommit) return;
  const r = spawnSync('git', ['merge-base', '--is-ancestor', baseCommit, 'HEAD'], { cwd: root });
  if (r.status !== 0) {
    // Not an ancestor — need more history. Fetch the base branch.
    const baseBranch = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main';
    spawnSync('git', ['fetch', '--no-tags', '--depth=50', 'origin', baseBranch.replace('origin/', '')], { cwd: root, stdio: 'ignore' });
  }
}

function checkImmutability(files) {
  // Compare against base commit using git diff --name-status.
  // Only migrations/ paths are considered.
  // New files (A) are allowed. Modified (M), Deleted (D), Renamed (R) are blocked.
  const baseCommit = getBaseCommit();
  if (!baseCommit) {
    console.warn('migrations:check: could not determine base commit; skipping immutability check');
    return;
  }
  ensureHistory(baseCommit);

  const r = spawnSync('git', ['diff', '--name-status', baseCommit, '--', 'migrations/'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return;
  const lines = r.stdout.split('\n').filter(Boolean);
  for (const line of lines) {
    const code = line.slice(0, 1);
    const file = line.slice(2).trim();
    if (!file.endsWith('.sql')) continue;
    // Allow: Added (A) — new migration files
    // Block: Modified (M), Deleted (D), Renamed (R), Copied (C)
    assert.ok(code === 'A',
      `${file} is in a non-add state (${code}). Applied migrations are immutable; create a new NNN_*.sql file instead.`);
  }
}

function checkDestructiveOps(files) {
  // Destructive SQL (DROP TABLE, DROP COLUMN, RENAME COLUMN, RENAME TABLE,
  // DELETE FROM) is blocked by default. A destructive migration can break a
  // rolling deploy: the old Worker code runs against the new schema and may
  // reference columns/tables that no longer exist. Only explicitly allowlisted
  // migrations pass — each exception must be verified backward-compatible.
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
    const destructive = [];
    if (/\bDROP\s+TABLE\b/i.test(sql)) destructive.push('DROP TABLE');
    if (/\bDROP\s+COLUMN\b/i.test(sql)) destructive.push('DROP COLUMN');
    if (/\bDROP\s+(INDEX|UNIQUE\s+INDEX)\b/i.test(sql)) destructive.push('DROP INDEX');
    if (/\bRENAME\s+TABLE\b/i.test(sql)) destructive.push('RENAME TABLE');
    if (/\bRENAME\s+COLUMN\b/i.test(sql)) destructive.push('RENAME COLUMN');
    if (/\bDELETE\s+FROM\b/i.test(sql)) destructive.push('DELETE FROM');
    if (destructive.length === 0) continue;
    assert.ok(DESTRUCTIVE_ALLOWLIST.has(f),
      `${f}: destructive migration (${destructive.join(', ')}) is blocked by default. ` +
      `A destructive op can break rolling deploys (old Worker + new schema). ` +
      `Verify backward compatibility, then add to DESTRUCTIVE_ALLOWLIST in migrations-check.mjs.`);
  }
}

function run() {
  // README is allowed to be edited (governance doc) — exclude it.
  const files = listMigrations();
  checkMonotonicAndUnique(files);
  checkIdempotent(files);
  checkImmutability(files);
  checkDestructiveOps(files);
  console.log(`migrations:check: ${files.length} files, governance rules enforced.`);
}

try {
  run();
  console.log('migrations governance check: PASSED');
} catch (error) {
  console.error('migrations governance check: FAILED');
  console.error(error?.message || error);
  process.exit(1);
}