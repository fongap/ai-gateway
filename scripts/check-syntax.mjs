#!/usr/bin/env node
// Checks JavaScript ES modules; TypeScript is handled by `npm run typecheck`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const files = [
  ...walk(path.join(root, 'src')),
  ...walk(path.join(root, 'scripts')),
  ...walk(path.join(root, 'tests')),
];

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    console.error(e.stderr?.toString() || e.message);
    throw new Error(`syntax check failed: ${path.relative(root, file)}`);
  }
}
console.log(`Syntax check passed (${files.length} JS/MJS files).`);
