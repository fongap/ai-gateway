import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const expectedName = String(process.env.WRANGLER_CI_OVERRIDE_NAME || '').trim();

if (!expectedName) {
  console.log('Wrangler CI name sync skipped: no Cloudflare Worker override was provided.');
  process.exit(0);
}

if (!/^[a-z0-9](?:[a-z0-9-]{0,253}[a-z0-9])?$/.test(expectedName)) {
  throw new Error(`Cloudflare provided an invalid Worker name: ${expectedName}`);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'wrangler.jsonc');
const source = fs.readFileSync(configPath, 'utf8');
const namePattern = /(^\s*"name"\s*:\s*)"([^"]*)"/m;
const match = source.match(namePattern);

if (!match) {
  throw new Error('wrangler.jsonc does not contain a top-level name property.');
}

if (match[2] === expectedName) {
  console.log(`Wrangler Worker name already matches "${expectedName}".`);
  process.exit(0);
}

const updated = source.replace(namePattern, `$1${JSON.stringify(expectedName)}`);
fs.writeFileSync(configPath, updated, 'utf8');
console.log(
  `Synchronized wrangler.jsonc Worker name for this Cloudflare build: "${expectedName}".`,
);
