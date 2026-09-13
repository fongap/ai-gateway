// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// D1 migration governance check.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const migDir = path.join(root, 'migrations');

const FILENAME_RE = /^(\d{3,})_([a-z0-9_]+)\.sql$/;

const DESTRUCTIVE_ALLOWLIST = new Set([
  '0007_drop_redundant_usage_indexes.sql',
]);

function listMigrations() {
  return fs.readdirSync(migDir).filter((file) => file.endsWith('.sql')).sort();
}

function parseName(file) {
  const match = FILENAME_RE.exec(file);
  if (!match) return null;
  return { num: Number.parseInt(match[1], 10), slug: match[2] };
}

function checkMonotonicAndUnique(files) {
  const seen = new Map();
  for (const file of files) {
    const parsed = parseName(file);
    assert.ok(parsed, `migration file "${file}" does not match NNN_slug.sql pattern`);
    assert.ok(seen.get(parsed.num) === undefined,
      `duplicate migration number ${parsed.num} (${file} vs ${seen.get(parsed.num)})`);
    seen.set(parsed.num, file);
  }
  const nums = [...seen.keys()].sort((a, b) => a - b);
  for (let i = 1; i < nums.length; i += 1) {
    assert.ok(nums[i] - nums[i - 1] === 1,
      `migration numbers must be strictly consecutive: gap between ${nums[i - 1]} and ${nums[i]}`);
  }
}

function checkIdempotent(files) {
  // Scan every individual CREATE occurrence. The previous implementation used
  // indexOf(stmt), which repeatedly inspected the first CREATE of the same type
  // and could miss a later non-idempotent CREATE in the same migration.
  const createRe = /\bCREATE\s+(?:TABLE|INDEX|UNIQUE\s+INDEX)\b/gi;
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migDir, file), 'utf8');
    for (const match of sql.matchAll(createRe)) {
      const offset = match.index ?? 0;
      const after = sql.slice(offset, offset + 240).toUpperCase();
      assert.ok(
        /\bIF\s+NOT\s+EXISTS\b/.test(after),
        `${file}: every CREATE must use IF NOT EXISTS so re-applies are no-ops (D1 has no migrations table)`,
      );
    }
  }
}

function getBaseCommit() {
  const envBase = process.env.GITHUB_BASE_REF;
  if (envBase) {
    const result = spawnSync('git', ['merge-base', `origin/${envBase}`, 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    const fallback = spawnSync('git', ['merge-base', 'origin/main', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (fallback.status === 0 && fallback.stdout.trim()) return fallback.stdout.trim();
  }
  const parent = spawnSync('git', ['rev-parse', 'HEAD~1'], { cwd: root, encoding: 'utf8' });
  if (parent.status === 0 && parent.stdout.trim()) return parent.stdout.trim();
  return null;
}

function ensureHistory(baseCommit) {
  if (!baseCommit) return;
  const result = spawnSync('git', ['merge-base', '--is-ancestor', baseCommit, 'HEAD'], { cwd: root });
  if (result.status !== 0) {
    const baseBranch = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main';
    spawnSync('git', ['fetch', '--no-tags', '--depth=50', 'origin', baseBranch.replace('origin/', '')], {
      cwd: root,
      stdio: 'ignore',
    });
  }
}

function checkImmutability(files) {
  const baseCommit = getBaseCommit();
  if (!baseCommit) {
    console.warn('migrations:check: could not determine base commit; skipping immutability check');
    return;
  }
  ensureHistory(baseCommit);
  const result = spawnSync('git', ['diff', '--name-status', baseCommit, '--', 'migrations/'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) return;
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const code = line.slice(0, 1);
    const file = line.slice(2).trim();
    if (!file.endsWith('.sql')) continue;
    assert.ok(code === 'A',
      `${file} is in a non-add state (${code}). Applied migrations are immutable; create a new NNN_*.sql file instead.`);
  }
}

function checkDestructiveOps(files) {
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migDir, file), 'utf8');
    const destructive = [];
    if (/\bDROP\s+TABLE\b/i.test(sql)) destructive.push('DROP TABLE');
    if (/\bDROP\s+COLUMN\b/i.test(sql)) destructive.push('DROP COLUMN');
    if (/\bDROP\s+(INDEX|UNIQUE\s+INDEX)\b/i.test(sql)) destructive.push('DROP INDEX');
    if (/\bRENAME\s+TABLE\b/i.test(sql)) destructive.push('RENAME TABLE');
    if (/\bRENAME\s+COLUMN\b/i.test(sql)) destructive.push('RENAME COLUMN');
    if (/\bDELETE\s+FROM\b/i.test(sql)) destructive.push('DELETE FROM');
    if (destructive.length === 0) continue;
    assert.ok(DESTRUCTIVE_ALLOWLIST.has(file),
      `${file}: destructive migration (${destructive.join(', ')}) is blocked by default. `
      + 'Verify backward compatibility before allowlisting it.');
  }
}

function run() {
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
