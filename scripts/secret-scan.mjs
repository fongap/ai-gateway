import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  ['AWS access key ID', /\bAKIA[0-9A-Z]{16}\b/g],
];

const sensitiveNames = [/^\.dev\.vars$/, /^\.env(?:\..+)?$/, /^secrets.*\.json$/i, /^wrangler\.user\.jsonc$/, /^gateway-.*-secrets.*\.json$/i];
const findings = [];

function scanFile(rel) {
  const normalized = rel.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.slice(0, -1).some((part) => excludedDirs.has(part))) return;
  const name = parts.at(-1);
  if (!name || excludedFiles.has(name) || name.startsWith('.wrangler-local-')) return;
  if (sensitiveNames.some((pattern) => pattern.test(name)) && !name.endsWith('.example')) {
    findings.push(`${normalized}: sensitive file must not be committed`);
    return;
  }
  const ext = path.extname(name);
  if (!textExtensions.has(ext) && !name.startsWith('.')) return;
  let content;
  try { content = fs.readFileSync(path.join(root, normalized), 'utf8'); } catch { return; }
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) findings.push(`${normalized}: possible ${label}`);
  }
}

// In a working tree, scan exactly what could enter a commit: tracked files plus
// untracked files not excluded by .gitignore. Local deployment material such
// as wrangler.user.jsonc remains on disk by design and must not make every
// post-configuration `npm run verify` fail. A forcibly tracked sensitive file
// is still returned by `git ls-files --cached` and is therefore rejected.
// Source archives may not contain .git; fall back to the conservative walk in
// that case so release artifacts still receive a useful scan.
let gitCandidates = null;
try {
  gitCandidates = execFileSync(
    'git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).split('\0').filter(Boolean);
} catch { /* archive / environment without git */ }

if (gitCandidates) {
  for (const rel of gitCandidates) scanFile(rel);
} else {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && excludedDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else scanFile(path.relative(root, full));
    }
  };
  walk(root);
}
if (findings.length) {
  console.error('Potential secrets detected:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log('Secret scan passed.');
