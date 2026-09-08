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

const version = pkg.version;
const nodeEngine = pkg.engines?.node;
if (!nodeEngine) {
  fail('package.json.engines.node is missing');
}

// Check version is valid semver (major.minor.patch)
const semverMatch = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
if (!semverMatch) {
  fail(`package.json.version="${version}" is not a valid semver`);
}

// package-lock.json must match package.json version (auto-synced by npm)
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

// Validate Node.js engine range format (must declare minimum >=22)
const nodeMatch = String(nodeEngine).match(/>=\s*(\d+)/);
if (!nodeMatch) {
  fail(`package.json.engines.node "${nodeEngine}" does not declare a minimum version (expected >=22)`);
} else {
  const minMajor = parseInt(nodeMatch[1], 10);
  if (minMajor < 22) {
    fail(`package.json.engines.node minimum major ${minMajor} is below the required 22`);
  }
}

// Check that the generated version module exists and matches
const versionModulePath = path.join(root, 'src', 'config', 'version.ts');
if (!fs.existsSync(versionModulePath)) {
  fail('Generated version module src/config/version.ts is missing (run generate-version.mjs)');
} else {
  const versionModuleContent = fs.readFileSync(versionModulePath, 'utf8');
  const moduleVersionMatch = versionModuleContent.match(/export const VERSION = '([^']+)'/);
  if (!moduleVersionMatch) {
    fail('src/config/version.ts does not contain expected VERSION export');
  } else if (moduleVersionMatch[1] !== version) {
    fail(`src/config/version.ts VERSION=${moduleVersionMatch[1]} does not match package.json.version=${version}`);
  }
}

if (failures.length > 0) {
  for (const m of failures) console.error(`FAIL - ${m}`);
  throw new Error(`Version check failed: ${failures.length} mismatch(es)`);
}

console.log(`Version check passed: ${version} (Node ${nodeEngine})`);
