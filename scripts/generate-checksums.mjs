import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excludedDirs = new Set(['.git', 'node_modules', '.wrangler', '.wrangler-dry-run', 'release']);
const excludedFiles = new Set(['SHA256SUMS']);
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (!excludedFiles.has(entry.name) && !entry.name.startsWith('.wrangler-local-')) files.push(full);
  }
}

walk(root);
files.sort((a, b) => a.localeCompare(b));
const lines = files.map((file) => {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const rel = path.relative(root, file).replaceAll(path.sep, '/');
  return `${hash}  ${rel}`;
});
fs.writeFileSync(path.join(root, 'SHA256SUMS'), `${lines.join('\n')}\n`);
console.log(`Generated SHA256SUMS for ${files.length} files.`);
