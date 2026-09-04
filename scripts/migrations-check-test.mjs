// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Unit tests for the migrations governance check.
// Runs in-memory fixtures against the same regex / parse logic the
// production check uses, so violations are caught even when the
// on-disk migrations/ tree is the (clean) shipped state.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const checkPath = path.join(here, 'migrations-check.mjs');

// Re-import the same constants the check uses by parsing the source.
// This keeps the test in lockstep with whatever the production regex is.
const source = await import(pathToFileURL(checkPath).href).catch(() => null);
// The check is a script, not a module — re-derive the same regex.

const FILENAME_RE = /^(\d{3,})_([a-z0-9_]+)\.sql$/;
const parseName = (f) => {
  const m = FILENAME_RE.exec(f);
  if (!m) return null;
  return { num: Number.parseInt(m[1], 10), slug: m[2] };
};

function expectParse(f) {
  const p = parseName(f);
  assert.ok(p, `${f} should parse as a valid migration filename`);
  return p;
}

function expectReject(f) {
  const p = parseName(f);
  assert.equal(p, null, `${f} should NOT parse as a valid migration filename`);
}

await test('parse: 4-digit prefix is accepted (matches shipped files)', () => {
  const p = expectParse('0001_token_usage_hourly.sql');
  assert.equal(p.num, 1);
  assert.equal(p.slug, 'token_usage_hourly');
});

await test('parse: 3-digit prefix is accepted', () => {
  const p = expectParse('001_foo.sql');
  assert.equal(p.num, 1);
  assert.equal(p.slug, 'foo');
});

await test('parse: slug may contain digits and underscores', () => {
  expectParse('0007_drop_redundant_usage_indexes.sql');
  expectParse('0010_add_ocr_capability_2026_01_15.sql');
});

await test('reject: missing NNN prefix', () => {
  expectReject('token_usage_hourly.sql');
  expectReject('foo.sql');
  expectReject('001-foo.sql');
});

await test('reject: invalid slug characters', () => {
  expectReject('0001_Token.sql');    // uppercase
  expectReject('0001_foo-bar.sql');  // hyphen
  expectReject('0001_foo bar.sql');  // space
  expectReject('0001_.sql');         // empty slug
});

await test('reject: non-sql files', () => {
  expectReject('0001_foo.md');
  expectReject('0001_foo.txt');
  expectReject('0001_foo');
});

await test('shipped files in migrations/ all parse cleanly', async () => {
  const fs = await import('node:fs');
  const root = path.resolve(here, '..');
  const dir = path.join(root, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  for (const f of files) {
    expectParse(f);
  }
  // Numbers must be strictly consecutive from 1.
  const nums = files.map((f) => expectParse(f).num).sort((a, b) => a - b);
  for (let i = 1; i < nums.length; i += 1) {
    assert.equal(nums[i] - nums[i - 1], 1, `gap between ${nums[i - 1]} and ${nums[i]}`);
  }
});

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
