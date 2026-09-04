import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function fail(message) {
  failures.push(message);
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const status = fs.readFileSync(path.join(root, 'src', 'observability', 'diagnostic-endpoints.mjs'), 'utf8');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const readmeEn = fs.readFileSync(path.join(root, 'README_EN.md'), 'utf8');

const version = pkg.version;
const nodeEngine = pkg.engines?.node;
if (!nodeEngine) {
  fail('package.json.engines.node is missing');
}

// package-lock.json
if (lock.version !== version) {
  fail(`package-lock.json.version=${lock.version} does not match package.json.version=${version}`);
}
const lockRoot = lock.packages?.[''];
if (!lockRoot) {
  fail('package-lock.json.packages[""] is missing');
} else {
  if (lockRoot.version !== version) {
    fail(`package-lock.json.packages[""].version=${lockRoot.version} does not match package.json.version=${version}`);
  }
  if (lockRoot.engines?.node !== nodeEngine) {
    fail(`package-lock.json.packages[""].engines.node=${lockRoot.engines?.node} does not match package.json.engines.node=${nodeEngine}`);
  }
}

// APP_META.version
const sourceVersion = status.match(/version:\s*'([^']+)'/)?.[1];
if (!sourceVersion) {
  fail('APP_META.version was not found in src/observability/diagnostic-endpoints.mjs');
} else if (sourceVersion !== version) {
  fail(`APP_META.version=${sourceVersion} does not match package.json.version=${version}`);
}

// CHANGELOG heading
if (!changelog.includes(`## ${version} -`)) {
  fail(`CHANGELOG.md does not contain a "## ${version} -" release heading`);
}

// README / README_EN: must mention the runtime requirement
const nodePattern = /(>=|>)(\s*)([0-9]+)/g;
function readEnginesFromReadme(text) {
  // Match the badge URL or any "Node.js >=N" mention.
  const matches = [];
  for (const m of text.matchAll(/Node\.js[^)\n]*?(>=|>)(\s*)(\d+)/gi)) {
    matches.push(m[3]);
  }
  for (const m of text.matchAll(/badge\/Node\.js-%3E%3D(\d+)/gi)) {
    matches.push(m[1]);
  }
  return matches;
}
const expectedMajor = parseInt(String(nodeEngine).replace(/[^0-9]/g, ''), 10);
for (const [name, text] of [['README.md', readme], ['README_EN.md', readmeEn]]) {
  const majors = new Set(readEnginesFromReadme(text).map((s) => parseInt(s, 10)));
  if (majors.size === 0) {
    fail(`${name} does not mention a Node.js major version (expected >=${expectedMajor})`);
  } else if (!majors.has(expectedMajor)) {
    fail(`${name} Node.js majors mentioned (${[...majors].join(', ')}) do not match package.json.engines.node (>=${expectedMajor})`);
  }
}

if (failures.length > 0) {
  for (const m of failures) console.error(`FAIL - ${m}`);
  throw new Error(`Version check failed: ${failures.length} mismatch(es)`);
}

console.log(`Version check passed: ${version} (Node ${nodeEngine})`);
