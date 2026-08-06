import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excludedDirs = new Set(['.git', 'node_modules', '.wrangler', '.wrangler-dry-run', 'release']);
const excludedFiles = new Set(['SHA256SUMS', 'secret-scan.mjs']);
const textExtensions = new Set([
  '.js', '.mjs', '.json', '.jsonc', '.md', '.txt', '.yml', '.yaml',
  '.toml', '.sh', '.ps1', '.env', '.example', '.gitignore', '.editorconfig',
]);

const patterns = [
  ['OpenAI-style key', new RegExp('s' + 'k-[A-Za-z0-9_-]{20,}', 'g')],
  ['GitHub token', new RegExp('g' + 'hp_[A-Za-z0-9]{20,}', 'g')],
  ['Google API key', new RegExp('A' + 'Iza[A-Za-z0-9_-]{20,}', 'g')],
  ['Private key', new RegExp('BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY', 'g')],
  ['Cloudflare API token assignment', /CLOUDFLARE_API_TOKEN\s*=\s*["']?[A-Za-z0-9_-]{30,}/g],
];

const sensitiveNames = [/^\.dev\.vars$/, /^\.env(?:\..+)?$/, /^secrets.*\.json$/i];
const findings = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replaceAll(path.sep, '/');
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (excludedFiles.has(entry.name) || entry.name.startsWith('.wrangler-local-')) continue;
    if (sensitiveNames.some((pattern) => pattern.test(entry.name)) && !entry.name.endsWith('.example')) {
      findings.push(`${rel}: sensitive file must not be committed`);
      continue;
    }
    const ext = path.extname(entry.name);
    if (!textExtensions.has(ext) && !entry.name.startsWith('.')) continue;
    let content;
    try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
    for (const [label, pattern] of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) findings.push(`${rel}: possible ${label}`);
    }
  }
}

walk(root);
if (findings.length) {
  console.error('Potential secrets detected:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log('Secret scan passed.');
