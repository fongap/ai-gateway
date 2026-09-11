#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Validates documentation structure, naming, and cross-reference integrity.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`ok - ${label}`);
  } else {
    failed++;
    console.error(`FAIL - ${label}${detail ? ': ' + detail : ''}`);
  }
}

const ALLOWED_DOCS_DIRS = ['architecture', 'governance', 'operations'];
const docsEntries = fs.readdirSync(path.join(root, 'docs'), { withFileTypes: true });
const docsDirs = docsEntries.filter(e => e.isDirectory()).map(e => e.name);
const docsRootMds = docsEntries.filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name);

const unexpectedDocsRoot = docsRootMds.filter(f => f !== 'README.md');
check(
  'docs/ root has no stray .md files',
  unexpectedDocsRoot.length === 0,
  unexpectedDocsRoot.length ? `unexpected: ${unexpectedDocsRoot.join(', ')}` : '',
);

const unexpectedDocsDirs = docsDirs.filter(d => !ALLOWED_DOCS_DIRS.includes(d));
check(
  `docs/ only contains allowed subdirectories: ${ALLOWED_DOCS_DIRS.join(', ')}`,
  unexpectedDocsDirs.length === 0,
  unexpectedDocsDirs.length ? `unexpected: ${unexpectedDocsDirs.join(', ')}` : '',
);

const ALLOWED_ROOT_MDS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'AGENTS.md', 'CLAUDE.md'];
const LOCALIZED_README_PATTERN = /^README\.[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\.md$/;
const rootEntries = fs.readdirSync(root, { withFileTypes: true });
const rootMds = rootEntries.filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name);
const localizedReadmes = rootMds.filter(f => LOCALIZED_README_PATTERN.test(f));
const unexpectedRootMds = rootMds.filter(f => !ALLOWED_ROOT_MDS.includes(f) && !LOCALIZED_README_PATTERN.test(f));
check(
  `root only contains allowed .md files plus localized README.<locale>.md files`,
  unexpectedRootMds.length === 0,
  unexpectedRootMds.length ? `unexpected: ${unexpectedRootMds.join(', ')}` : '',
);

function isKebabCase(name) {
  return /^[a-z0-9]+(-[a-z0-9]+)*\.md$/.test(name) || name === 'README.md';
}

function collectDocsMd(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectDocsMd(full));
    else if (entry.name.endsWith('.md')) results.push(full);
  }
  return results;
}

const allDocsMd = collectDocsMd(path.join(root, 'docs'));
for (const file of allDocsMd) {
  const name = path.basename(file);
  check(
    `naming: ${path.relative(root, file)}`,
    isKebabCase(name),
    `"${name}" is not lowercase-kebab-case.md`,
  );
}

const FORBIDDEN_PATTERNS = [/\bfinal\b/i, /\blatest\b/i, /\bnew\b/i, /\btemp\b/i, /\btemporary\b/i, /\bold\b/i, /\bbackup\b/i, /\bv[2-9]\b/i, /\bdraft\b/i, /\bmisc\b/i];
for (const file of allDocsMd) {
  const name = path.basename(file, '.md');
  if (name === 'README') continue;
  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.test(name)) {
      check(
        `no state-like name: ${path.relative(root, file)}`,
        false,
        `"${name}" matches forbidden pattern ${pat}`,
      );
      break;
    }
  }
}

const LINK_PATTERN = /!?(?:\[[^\]]*\])\(([^)]+)\)/g;
const MD_FILES = [
  'README.md',
  ...localizedReadmes,
  'CONTRIBUTING.md',
  ...allDocsMd.map(f => path.relative(root, f)),
];

const missingLinks = [];
for (const relFile of MD_FILES) {
  const file = path.join(root, relFile);
  if (!fs.existsSync(file)) continue;
  const content = fs.readFileSync(file, 'utf8');
  for (const match of content.matchAll(LINK_PATTERN)) {
    let target = match[1].trim();
    if (!target || target.startsWith('#') || /^(https?:|mailto:)/i.test(target)) continue;
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split('#', 1)[0].split('?', 1)[0];
    try { target = decodeURIComponent(target); } catch {}
    const resolved = path.resolve(path.dirname(file), target);
    if (!fs.existsSync(resolved)) {
      missingLinks.push(`${relFile} -> ${target}`);
    }
  }
}
check(
  'internal Markdown links are valid',
  missingLinks.length === 0,
  missingLinks.length ? `missing: ${missingLinks.join('; ')}` : '',
);

const govReadme = path.join(root, 'docs/governance/README.md');
if (fs.existsSync(govReadme)) {
  const govContent = fs.readFileSync(govReadme, 'utf8');
  const expectedLinks = ['development-policy.md', 'quality-policy.md', 'dependency-policy.md', 'version-policy.md', 'documentation-policy.md'];
  const missingLinks = expectedLinks.filter(l => !govContent.includes(l));
  check(
    'governance/README.md indexes all governance files',
    missingLinks.length === 0,
    missingLinks.length ? `missing links to: ${missingLinks.join(', ')}` : '',
  );
} else {
  check('governance/README.md exists', false, 'file not found');
}

console.log(`\ndocs-check: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
