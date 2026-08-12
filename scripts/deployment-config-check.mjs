import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const config = JSON.parse(read('wrangler.jsonc'));
const packageJson = JSON.parse(read('package.json'));

assert.equal(config.keep_vars, true, 'wrangler.jsonc must set keep_vars=true');
assert.equal(config.main, 'src/index.js');
assert.equal(
  config.secrets,
  undefined,
  'wrangler.jsonc must not block the first deployment before runtime Secrets can be configured',
);
assert.equal(
  packageJson.scripts?.postbuild,
  'node scripts/sync-wrangler-ci-name.mjs',
  'postbuild must synchronize the connected Cloudflare Worker name',
);
assert.ok(
  fs.existsSync(path.join(root, 'scripts/sync-wrangler-ci-name.mjs')),
  'Missing Cloudflare Worker name synchronization script',
);
assert.ok(fs.existsSync(path.join(root, 'package-lock.json')), 'package-lock.json is required for npm ci');

for (const file of [
  'scripts/install.sh', 'scripts/install.ps1',
  'scripts/update.sh', 'scripts/update.ps1',
  'scripts/reconfigure.sh', 'scripts/reconfigure.ps1',
  'scripts/disable-fallback.sh', 'scripts/disable-fallback.ps1',
  'scripts/validate-primary-config.mjs', 'scripts/validate-fallback-config.mjs',
]) {
  assert.ok(fs.existsSync(path.join(root, file)), `Missing deployment file: ${file}`);
}

for (const file of ['scripts/install.sh', 'scripts/install.ps1']) {
  const source = read(file);
  assert.match(source, /--secrets-file|secrets-file/, `${file} must deploy required secrets during first install`);
  assert.match(source, /--keep-vars|keep-vars/, `${file} must preserve remote vars`);
}
for (const file of ['scripts/update.sh', 'scripts/update.ps1']) {
  const source = read(file);
  assert.match(source, /--keep-vars|keep-vars/, `${file} must preserve remote vars`);
  assert.doesNotMatch(source, /--secrets-file|secrets-file/, `${file} must not rewrite secrets during code-only update`);
}
for (const file of ['scripts/reconfigure.sh', 'scripts/reconfigure.ps1', 'scripts/disable-fallback.sh', 'scripts/disable-fallback.ps1']) {
  assert.match(read(file), /secret bulk/, `${file} must update runtime secrets without deploying local code`);
}

const releaseSource = read('scripts/prepare-release.mjs');
for (const token of ['.wrangler-dry-run', '.wrangler-dry-run-config.jsonc', '.wrangler-local-', 'node_modules', 'release']) {
  assert.match(releaseSource, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `Release staging must exclude ${token}`);
}
console.log('Deployment configuration check passed.');
