#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Provider / Model Discovery CLI.
//
// Offline commands keep the original catalog-audit behavior. `live` reads the
// gateway's configured provider nodes + credentials, calls /v1/models, performs
// zero-generation-cost surface probes, and writes sanitized before/after model
// snapshots. No command mutates Runtime Node config, Model Registry, Variables
// or Secrets.

import fs from 'node:fs';
import path from 'node:path';

import {
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
  scanDiscoveryEnv,
  diffModelSnapshots,
  formatDiscoveryMarkdown,
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
  const { _: rest } = readArgs(argv);
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
    warnings: [],
    generatedAt: new Date().toISOString(),
  });
  const json = formatJsonReport({
    diff,
    warnings: [],
    catalog: after,
    generatedAt: new Date().toISOString(),
  });
  if (opts.out) fs.writeFileSync(resolveAgainstCwd(opts.out), md);
  else if (!opts['json-out']) process.stdout.write(`${md}\n`);
  if (opts['json-out']) fs.writeFileSync(resolveAgainstCwd(opts['json-out']), json);
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
    runtimeView = normalizeRuntimeView(JSON.parse(text));
  } catch (e) {
    die(`failed to load runtime view: ${e.message}`);
  }
  const warnings = checkRuntimeAgainstCatalog(runtimeView, catalog);
  const sev = summarizeWarnings(warnings);
  if (opts['json-out']) {
    fs.writeFileSync(resolveAgainstCwd(opts['json-out']), JSON.stringify({ warnings, severity_summary: sev }, null, 2));
  } else if (warnings.length === 0) {
    console.log('No runtime consistency warnings.');
  } else {
    for (const w of warnings) console.log(`[${w.severity}] ${w.kind}: ${w.detail}`);
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
  process.stdout.write(formatActionSummary({
    diff: { added: [], removed: [], changed: [] },
    warnings: [],
    capability,
    generatedAt: new Date().toISOString(),
  }));
}

function loadPreviousSnapshot(file) {
  if (!file) return { schema_version: 1, generated_at: null, nodes: [] };
  const resolved = resolveAgainstCwd(file);
  if (!fs.existsSync(resolved)) return { schema_version: 1, generated_at: null, nodes: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return parsed && Array.isArray(parsed.nodes) ? parsed : { schema_version: 1, generated_at: null, nodes: [] };
  } catch {
    return { schema_version: 1, generated_at: null, nodes: [] };
  }
}

async function cmdLive(argv) {
  const { opts } = readArgs(argv);
  const outDir = resolveAgainstCwd(String(opts['out-dir'] || 'model-discovery'));
  const previous = loadPreviousSnapshot(opts.previous ? String(opts.previous) : '');
  const allowPrivate = String(process.env.ALLOW_PRIVATE_DISCOVERY || '').trim().toLowerCase() === 'true';
  const current = await scanDiscoveryEnv(process.env, { allowPrivate });
  const diff = diffModelSnapshots(previous, current);
  const markdown = formatDiscoveryMarkdown(previous, current, diff);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'previous-models.json'), JSON.stringify(previous, null, 2));
  fs.writeFileSync(path.join(outDir, 'current-models.json'), JSON.stringify(current, null, 2));
  fs.writeFileSync(path.join(outDir, 'changes.json'), JSON.stringify(diff, null, 2));
  fs.writeFileSync(path.join(outDir, 'changes.md'), markdown);
  fs.writeFileSync(path.join(outDir, 'capabilities.json'), JSON.stringify({
    generated_at: current.generated_at,
    nodes: current.nodes.map((n) => ({
      node_id: n.node_id,
      provider: n.provider,
      protocol: n.protocol,
      status: n.status,
      capabilities: n.capabilities,
    })),
  }, null, 2));

  const ok = current.nodes.filter((n) => n.status === 'ok').length;
  const failed = current.nodes.length - ok;
  const added = diff.changes.reduce((n, c) => n + c.added.length, 0);
  const removed = diff.changes.reduce((n, c) => n + c.removed.length, 0);
  console.log(`Model Discovery: nodes=${current.nodes.length}, ok=${ok}, failed=${failed}, added=${added}, removed=${removed}`);
  process.stdout.write(markdown);
  if (current.nodes.length === 0 || ok === 0) process.exitCode = 2;
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
  case 'live':
    await cmdLive(rest);
    break;
  case undefined:
  case '-h':
  case '--help':
    console.log('Usage: provider-discovery.mjs <live|check-snapshot|diff|runtime-check|summary> ...');
    break;
  default:
    die(`unknown subcommand: ${subcommand}`);
}
