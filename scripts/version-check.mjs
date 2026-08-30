import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const status = fs.readFileSync(path.join(root, 'src', 'observability', 'diagnostic-endpoints.mjs'), 'utf8');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

const sourceVersion = status.match(/version:\s*'([^']+)'/)?.[1];
if (!sourceVersion) throw new Error('APP_META.version was not found in src/observability/diagnostic-endpoints.mjs.');
if (sourceVersion !== pkg.version) {
  throw new Error(`Version mismatch: package.json=${pkg.version}, src/index.js=${sourceVersion}`);
}
if (!changelog.includes(`## ${pkg.version} -`)) {
  throw new Error(`CHANGELOG.md does not contain a ${pkg.version} release heading.`);
}

console.log(`Version check passed: ${pkg.version}`);
