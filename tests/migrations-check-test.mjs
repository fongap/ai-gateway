// SPDX-License-Identifier: MIT
// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertIdempotentCreateStatements } from '../scripts/migrations-check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const FILENAME_RE = /^(\d{3,})_([a-z0-9_]+)\.sql$/;
const parseName = (file) => {
  const match = FILENAME_RE.exec(file);
  return match ? { num: Number.parseInt(match[1], 10), slug: match[2] } : null;
};

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

await test('valid migration filenames parse', () => {
  assert.deepEqual(parseName('0001_token_usage_hourly.sql'), { num: 1, slug: 'token_usage_hourly' });
  assert.deepEqual(parseName('001_foo.sql'), { num: 1, slug: 'foo' });
  assert.ok(parseName('0007_drop_redundant_usage_indexes.sql'));
});

await test('invalid migration filenames are rejected', () => {
  for (const file of ['token_usage_hourly.sql', '001-foo.sql', '0001_Token.sql', '0001_foo-bar.sql', '0001_foo.md']) {
    assert.equal(parseName(file), null, file);
  }
});

await test('shipped migrations are consecutive and idempotent', () => {
  const dir = path.join(root, 'migrations');
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
  const nums = [];
  for (const file of files) {
    const parsed = parseName(file);
    assert.ok(parsed, `${file} must parse`);
    nums.push(parsed.num);
    assertIdempotentCreateStatements(fs.readFileSync(path.join(dir, file), 'utf8'), file);
  }
  nums.sort((a, b) => a - b);
  for (let i = 1; i < nums.length; i++) assert.equal(nums[i] - nums[i - 1], 1);
});

await test('every CREATE is checked, not only the first CREATE of a type', () => {
  const sql = `
    CREATE TABLE IF NOT EXISTS first_table (id INTEGER PRIMARY KEY);
    CREATE TABLE second_table (id INTEGER PRIMARY KEY);
  `;
  assert.throws(
    () => assertIdempotentCreateStatements(sql, 'fixture.sql'),
    /every CREATE must use IF NOT EXISTS/,
  );
});

await test('multiple idempotent CREATE statements pass', () => {
  const sql = `
    CREATE TABLE IF NOT EXISTS first_table (id INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS second_table (id INTEGER PRIMARY KEY);
    CREATE INDEX IF NOT EXISTS idx_second ON second_table(id);
  `;
  assert.doesNotThrow(() => assertIdempotentCreateStatements(sql, 'fixture.sql'));
});
