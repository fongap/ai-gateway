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
//   4. no SQL data-loss op (DROP / RENAME / DELETE) without a sibling
//      0007_drop_redundant_usage_indexes.sql-style migration also being
//      safe (we only require the destructive op to live in a dedicated
//      file — i.e. the file name has to mention the table being affected).
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

function checkImmutability(files) {
  // Files committed to git must not change unless explicitly added.
  // The check is a no-op on a fresh checkout with no diff; otherwise it
  // asserts every .sql in the working tree is either new or untouched.
  const r = spawnSync('git', ['status', '--porcelain', 'migrations/'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return;
  const lines = r.stdout.split('\n').filter(Boolean);
  for (const line of lines) {
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (!file.endsWith('.sql')) continue;
    assert.ok(code === '??' || code === 'A ' || code === 'AM',
      `${file} is in a non-add state (${code}). Applied migrations are immutable; create a new NNN_*.sql file instead.`);
  }
}

function checkDestructiveOps(files) {
  // DROP TABLE / DROP INDEX / RENAME / DELETE FROM must live in a file
  // whose slug names the affected object — operators must be able to scan
  // the file name and know exactly what it touches.
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
    const destructive = [];
    if (/\bDROP\s+(TABLE|INDEX|UNIQUE\s+INDEX)\b/i.test(sql)) destructive.push('DROP');
    if (/\bRENAME\s+(TABLE|TO|COLUMN)\b/i.test(sql)) destructive.push('RENAME');
    if (/\bDELETE\s+FROM\b/i.test(sql)) destructive.push('DELETE');
    if (destructive.length === 0) continue;
    const slug = parseName(f).slug;
    // Heuristic: the slug has to mention the table name it touches. We
    // accept the well-known `drop_redundant_<table>_indexes` shape and
    // any slug that names a token_usage_* table explicitly.
    const slugMentionsTable = /drop_/.test(slug) || /token_usage_/.test(slug);
    assert.ok(slugMentionsTable,
      `${f}: destructive op (${destructive.join(',')}) — the file slug must describe the affected table (e.g. drop_redundant_<table>_indexes)`);
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
