#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Provider Discovery CLI (v1.1).
//
// Local operator tool. Subcommands:
//
//   check-snapshot <file>
//       Validate + normalize a Catalog snapshot; print diagnostics.
//       Does NOT touch Runtime Node configuration.
//
//   diff <before.json> <after.json>
//       Semantic diff between two Catalog snapshots. Writes a markdown
//       report to stdout (or --out) plus a JSON artifact (--json-out).
//
//   runtime-check <catalog.json> <runtime-view.json>
//       Run the Runtime consistency check; print warnings sorted by
//       severity. Does NOT mutate runtime.
//
//   summary <catalog.json>
//       Print a short protocol/surface capability summary suitable for
//       a GitHub Action Summary step.
//
// Design constraints (see provider-discovery-test.mjs for invariant tests):
//   - Secrets / credentials MUST NEVER appear in any output.
//   - The CLI never imports src/runtime, src/scheduler, src/transport,
//     src/request, src/reliability, or src/stream — discovery is
//     intentionally decoupled from the request hot path.
//   - The CLI never writes Runtime Node configuration.
//
// Exit codes:
//   0   Success, no P0/P1 issues.
//   1   Generic failure (bad arguments, missing files).
//   2   At least one P0 or P1 warning emitted (operator must review).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateCatalog,
  loadCatalogFile,
  normalizeCatalog,
  normalizeRuntimeView,
  diffCatalogs,
  summarizeBySeverity,
  checkRuntimeAgainstCatalog,
  summarizeWarnings,
  aggregateCatalogCapabilities,
  formatChangesMarkdown,
  formatActionSummary,
  formatJsonReport,
} from './provider-discovery/index.js';

function die(msg, code = 1) {
  console.error(`ERROR: ${msg}`);
  process.exit(code);
}

function readArgs(argv) {
  const out = { _: [], opts: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        out.opts[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          out.opts[key] = next;
          i += 1;
        } else {
          out.opts[key] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function resolveAgainstCwd(p) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function loadCatalogOrDie(filePath) {
  const resolved = resolveAgainstCwd(filePath);
  if (!fs.existsSync(resolved)) die(`catalog file not found: ${resolved}`);
  let result;
  try {
    result = loadCatalogFile(resolved);
  } catch (e) {
    die(e.message);
  }
  if (!result.valid) {
    console.error(`WARN: catalog at ${resolved} has structural issues:`);
    for (const w of result.loadWarnings) console.error(`  - ${w}`);
  }
  const norm = normalizeCatalog(result.catalog);
  if (norm.warnings.length > 0) {
    console.error('WARN: catalog normalization warnings:');
    for (const w of norm.warnings) console.error(`  - ${w}`);
  }
  return { raw: result, normalized: norm.catalog };
}

function cmdCheckSnapshot(argv) {
  const { _: rest, opts } = readArgs(argv);
  const file = rest[0];
  if (!file) die('usage: provider-discovery.mjs check-snapshot <catalog.json>');
  const { raw, normalized } = loadCatalogOrDie(file);
  console.log(`Catalog file: ${path.resolve(file)}`);
  console.log(`Schema valid: ${raw.valid}`);
  console.log(`Providers: ${Object.keys(normalized.providers).length}`);
  for (const name of Object.keys(normalized.providers).sort()) {
    const p = normalized.providers[name];
    for (const proto of Object.keys(p)) {
      const e = p[proto];
      console.log(`  - ${name} [${proto}]: supported=${e.supported} surfaces=[${e.surfaces.join(',')}] evidence=${e.evidence} base_url=${e.base_url || '(null)'}`);
    }
  }
  process.exit(raw.valid ? 0 : 1);
}

function cmdDiff(argv) {
  const { _: rest, opts } = readArgs(argv);
  const [beforePath, afterPath] = rest;
  if (!beforePath || !afterPath) die('usage: provider-discovery.mjs diff <before.json> <after.json> [--out FILE] [--json-out FILE]');
  const before = loadCatalogOrDie(beforePath).normalized;
  const after = loadCatalogOrDie(afterPath).normalized;
  const diff = diffCatalogs(before, after);
  const sev = summarizeBySeverity(diff);
  const md = formatChangesMarkdown({
    diff,
    catalog: after,
    warnings: [], // runtime warnings are computed in `runtime-check`
    generatedAt: new Date().toISOString(),
  });
  const json = formatJsonReport({
    diff,
    warnings: [],
    catalog: after,
    generatedAt: new Date().toISOString(),
  });
  // Markdown report: --out writes to file, otherwise stdout.
  if (opts.out) {
    fs.writeFileSync(resolveAgainstCwd(opts.out), md);
  } else if (!opts['json-out']) {
    // If neither --out nor --json-out is given, default to markdown on
    // stdout so the diff is human-readable. When --json-out is given
    // (with or without --out), markdown is only written via --out.
    process.stdout.write(md);
    process.stdout.write('\n');
  }
  // JSON artifact: --json-out writes to file, otherwise not emitted to
  // avoid double-output when no flags are given (markdown is the
  // default human-readable surface).
  if (opts['json-out']) {
    fs.writeFileSync(resolveAgainstCwd(opts['json-out']), json);
  }
  // Surface severity counts to stderr for quick scanning.
  console.error(`diff summary: added=${sev.added} removed=${sev.removed} P1=${sev.P1} P2=${sev.P2} P3=${sev.P3}`);
}

function cmdRuntimeCheck(argv) {
  const { _: rest, opts } = readArgs(argv);
  const [catalogPath, runtimePath] = rest;
  if (!catalogPath || !runtimePath) die('usage: provider-discovery.mjs runtime-check <catalog.json> <runtime-view.json> [--json-out FILE]');
  const catalog = loadCatalogOrDie(catalogPath).normalized;
  let runtimeView;
  try {
    const text = fs.readFileSync(resolveAgainstCwd(runtimePath), 'utf8');
    const parsed = JSON.parse(text);
    runtimeView = normalizeRuntimeView(parsed);
  } catch (e) {
    die(`failed to load runtime view: ${e.message}`);
  }
  const warnings = checkRuntimeAgainstCatalog(runtimeView, catalog);
  const sev = summarizeWarnings(warnings);
  if (opts['json-out']) {
    fs.writeFileSync(resolveAgainstCwd(opts['json-out']), JSON.stringify({ warnings, severity_summary: sev }, null, 2));
  } else {
    if (warnings.length === 0) {
      console.log('No runtime consistency warnings.');
    } else {
      for (const w of warnings) {
        console.log(`[${w.severity}] ${w.kind}: ${w.detail}`);
      }
    }
    console.error(`runtime summary: P0=${sev.P0} P1=${sev.P1} P2=${sev.P2} P3=${sev.P3}`);
  }
  if (sev.P0 > 0 || sev.P1 > 0) process.exit(2);
}

function cmdSummary(argv) {
  const { _: rest } = readArgs(argv);
  const file = rest[0];
  if (!file) die('usage: provider-discovery.mjs summary <catalog.json>');
  const { normalized } = loadCatalogOrDie(file);
  const capability = aggregateCatalogCapabilities(normalized);
  const text = formatActionSummary({
    diff: { added: [], removed: [], changed: [] },
    warnings: [],
    capability,
    generatedAt: new Date().toISOString(),
  });
  process.stdout.write(text);
}

const subcommand = process.argv[2];
const rest = process.argv.slice(3);
switch (subcommand) {
  case 'check-snapshot':
    cmdCheckSnapshot(rest);
    break;
  case 'diff':
    cmdDiff(rest);
    break;
  case 'runtime-check':
    cmdRuntimeCheck(rest);
    break;
  case 'summary':
    cmdSummary(rest);
    break;
  case undefined:
  case '-h':
  case '--help':
    console.log('Usage: provider-discovery.mjs <check-snapshot|diff|runtime-check|summary> ...');
    console.log('See scripts/provider-discovery/README.md for details.');
    break;
  default:
    die(`unknown subcommand: ${subcommand}`);
}
