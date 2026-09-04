#!/usr/bin/env node
// Unit tests for scripts/version-check.mjs metadata drift detection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versionCheckUrl = pathToFileURL(path.join(root, 'scripts', 'version-check.mjs')).href;

const results = [];

function recordResult(name, ok, err) {
  results.push({ name, ok, err });
}

function writeAndRestore(rel, mutator) {
  const file = path.join(root, rel);
  const original = fs.readFileSync(file, 'utf8');
  const mutated = mutator(original);
  fs.writeFileSync(file, mutated);
  return () => fs.writeFileSync(file, original);
}

async function reloadCheck() {
  return import(`${versionCheckUrl}?t=${Date.now()}&r=${Math.random()}`);
}

// Capture console.error to inspect the FAIL lines emitted by version-check.mjs.
async function captureCheckFailures(p) {
  const origError = console.error;
  const captured = [];
  console.error = (...args) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  let result, err;
  try {
    result = await p;
  } catch (e) {
    err = e;
  } finally {
    console.error = origError;
  }
  return { captured, result, err };
}

function expectFailuresInCapture({ captured, err }, pattern) {
  if (!err) throw new Error('expected rejection, got resolution');
  for (const line of captured) {
    if (pattern.test(line)) return;
  }
  throw new Error(`expected captured FAIL matching ${pattern}; got: ${captured.join('\n')}`);
}

const tests = [
  ['version-check.mjs passes against the current repo state', async () => {
    const out = await captureCheckFailures(reloadCheck());
    assert.equal(out.err, undefined, `expected no error, got ${out.err && out.err.message}\ncaptured: ${out.captured.join('\n')}`);
  }],
  ['version-check.mjs rejects a version mismatch in package.json', async () => {
    const restore = writeAndRestore('package.json', (text) => {
      const obj = JSON.parse(text);
      obj.version = '9.9.9-fake';
      return JSON.stringify(obj, null, 2) + '\n';
    });
    try {
      const out = await captureCheckFailures(reloadCheck());
      expectFailuresInCapture(out, /package-lock\.json\.version=1\.2\.7 does not match package\.json\.version=9\.9\.9-fake/);
    } finally {
      restore();
    }
  }],
  ['version-check.mjs rejects a lockfile version drift', async () => {
    const restore = writeAndRestore('package-lock.json', (text) => {
      const obj = JSON.parse(text);
      obj.version = '0.0.0-drift';
      obj.packages[''].version = '0.0.0-drift';
      return JSON.stringify(obj, null, 2) + '\n';
    });
    try {
      const out = await captureCheckFailures(reloadCheck());
      expectFailuresInCapture(out, /package-lock\.json\.version=0\.0\.0-drift/);
    } finally {
      restore();
    }
  }],
  ['version-check.mjs rejects engines.node drift in lockfile', async () => {
    const restore = writeAndRestore('package-lock.json', (text) => {
      const obj = JSON.parse(text);
      obj.packages[''].engines = { node: '>=99' };
      return JSON.stringify(obj, null, 2) + '\n';
    });
    try {
      const out = await captureCheckFailures(reloadCheck());
      expectFailuresInCapture(out, /package-lock\.json\.packages\[""\]\.engines\.node/);
    } finally {
      restore();
    }
  }],
  ['version-check.mjs rejects APP_META.version drift', async () => {
    const restore = writeAndRestore('src/observability/diagnostic-endpoints.mjs', (text) => {
      return text.replace(/version:\s*'1\.2\.7'/, "version: '9.9.9-fake'");
    });
    try {
      const out = await captureCheckFailures(reloadCheck());
      expectFailuresInCapture(out, /APP_META\.version=9\.9\.9-fake/);
    } finally {
      restore();
    }
  }],
  ['version-check.mjs rejects a missing CHANGELOG heading', async () => {
    const restore = writeAndRestore('CHANGELOG.md', (text) => {
      return text.replace(/## 1\.2\.7 - /, '## moved-heading-no-trailing-dash ');
    });
    try {
      const out = await captureCheckFailures(reloadCheck());
      expectFailuresInCapture(out, /CHANGELOG\.md does not contain/);
    } finally {
      restore();
    }
  }],
  ['version-check.mjs rejects README Node version drift', async () => {
    const restore = writeAndRestore('README.md', (text) => {
      return text.replace(/Node\.js-%3E%3D22/, 'Node.js-%3E%3D99');
    });
    try {
      const out = await captureCheckFailures(reloadCheck());
      expectFailuresInCapture(out, /README\.md Node\.js majors/);
    } finally {
      restore();
    }
  }],
];

for (const [name, fn] of tests) {
  try {
    await fn();
    recordResult(name, true);
  } catch (e) {
    recordResult(name, false, e);
  }
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
for (const r of results) {
  if (!r.ok) {
    console.error(`FAIL: ${r.name}`);
    console.error(r.err && r.err.stack || r.err);
  }
}
if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log(`version-check tests passed (${passed}).`);
}
