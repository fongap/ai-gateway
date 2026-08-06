import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

function run(script, env = {}, args = []) {
  return spawnSync(node, [path.join(root, 'scripts', script), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

let result = run('validate-primary-config.mjs', {
  PRIMARY_API_TOKENS: 'token@with-at@https://primary.example/v1',
  PRIMARY_BASE_URL: '',
});
assert.equal(result.status, 0, result.stderr);

result = run('validate-primary-config.mjs', {
  PRIMARY_API_TOKENS: 'token@https://user:pass@primary.example/v1',
  PRIMARY_BASE_URL: '',
});
assert.notEqual(result.status, 0);

result = run('validate-primary-config.mjs', {
  PRIMARY_API_TOKENS: 'a@https://a.example/v1;b@https://b.example/v1',
  PRIMARY_BASE_URL: '',
});
assert.notEqual(result.status, 0);

result = run('validate-fallback-config.mjs', {
  FALLBACK_API_TOKEN: 'token',
  FALLBACK_BASE_URL: 'https://fallback.example/v1',
  FALLBACK_PRIMARY_MODEL: 'model-pro',
  FALLBACK_SECONDARY_MODEL: 'off',
});
assert.equal(result.status, 0, result.stderr);

result = run('validate-fallback-config.mjs', {
  FALLBACK_API_TOKEN: 'token',
  FALLBACK_BASE_URL: 'https://user:pass@fallback.example/v1',
  FALLBACK_PRIMARY_MODEL: 'model-pro',
  FALLBACK_SECONDARY_MODEL: 'off',
});
assert.notEqual(result.status, 0);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seg-config-test-'));
try {
  const validMapping = path.join(tempDir, 'valid.json');
  fs.writeFileSync(validMapping, JSON.stringify({
    'PRIMARY.EXAMPLE': {
      alias: { model: 'vendor/model', request_overrides: { temperature: 0 } },
    },
  }));
  result = run('validate-model-mapping.mjs', {}, [validMapping]);
  assert.equal(result.status, 0, result.stderr);

  const invalidMapping = path.join(tempDir, 'invalid.json');
  fs.writeFileSync(invalidMapping, JSON.stringify({
    'primary.example': {
      alias: { model: 'vendor/model', request_overrides: { stream: true } },
    },
  }));
  result = run('validate-model-mapping.mjs', {}, [invalidMapping]);
  assert.notEqual(result.status, 0);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('Configuration validation tests passed.');
