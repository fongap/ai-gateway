import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getArtifactBaseName } from './project-meta.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseName = getArtifactBaseName();
const releaseDir = path.join(root, 'release');
const stageRoot = path.join(releaseDir, '.staging');
const stageDir = path.join(stageRoot, baseName);
const excludedDirs = new Set(['.git', 'node_modules', '.wrangler', '.wrangler-dry-run', 'release']);
const excludedNames = new Set(['.dev.vars', '.wrangler-dry-run-config.jsonc', 'wrangler.user.jsonc']);

fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

function shouldExclude(name) {
  if (excludedNames.has(name) || name.startsWith('.wrangler-local-')) return true;
  if (/^\.env(?:\..+)?$/.test(name) && name !== '.env.example') return true;
  if (/^secrets.*\.json$/i.test(name)) return true;
  if (/\.(zip|tar\.gz)$/i.test(name)) return true;
  return false;
}

function copyTree(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirs.has(entry.name)) continue;
    if (shouldExclude(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyTree(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

copyTree(root, stageDir);
console.log(JSON.stringify({ baseName, releaseDir, stageRoot, stageDir }));
