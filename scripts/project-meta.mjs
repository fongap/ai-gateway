import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readPackageMeta() {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
}

export function getArtifactBaseName(pkg = readPackageMeta()) {
  return `${sanitizeName(pkg.name)}-v${pkg.version}`;
}

export function getRepositoryUrl(pkg = readPackageMeta()) {
  const configured = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (configured) return normalizeGitUrl(configured);
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return normalizeGitUrl(remote);
  } catch {
    return '';
  }
}

function sanitizeName(value) {
  const name = String(value || 'release').replace(/^@/, '').replaceAll('/', '-');
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function normalizeGitUrl(value) {
  return String(value)
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
}
