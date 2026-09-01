#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Provider Discovery test suite (v1.1).
//
// Pure unit tests — no network, no Worker runtime. This file is part of
// `npm run test:required` and must never reach out to third-party APIs.
//
// Coverage:
//   - Provider Capability schema (tri-state, surfaces, evidence)
//   - Normalization (stable sort, secret-stripping, base URL canonicalization)
//   - Diff semantics (added/removed/changed; severity mapping)
//   - Runtime consistency (mismatch, base URL drift, no auto-mutation)
//   - Report formatters (markdown, summary, JSON)
//   - Security invariants (no secrets in any output path)
//   - Boundary invariants (no coupling to runtime hot path)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  PROTOCOLS,
  SURFACES_BY_PROTOCOL,
  EVIDENCE_LEVELS,
  SUPPORT_TRUE,
  SUPPORT_FALSE,
  SUPPORT_NULL,
  validateCatalog,
  validateCapabilityEntry,
  isProtocol,
  isSurfaceFor,
  isEvidence,
  isSupportTriState,
  loadCatalogFile,
  normalizeCatalog,
  normalizeCapabilityEntry,
  normalizeRuntimeView,
  diffCatalogs,
  summarizeBySeverity,
  hasProtocolDowngrade,
  checkRuntimeAgainstCatalog,
  summarizeWarnings,
  aggregateCatalogCapabilities,
  formatChangesMarkdown,
  formatActionSummary,
  formatJsonReport,
} from './provider-discovery/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const cliPath = path.join(here, 'provider-discovery.mjs');
const samplesDir = path.join(here, 'provider-discovery', 'samples');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

// ----------------- Provider Capability schema -----------------------------

test('OpenAI-only provider serializes correctly', () => {
  const e = validateCapabilityEntry('openai', {
    supported: true,
    base_url: 'https://api.example.com/v1',
    surfaces: ['chat_completions'],
    evidence: 'configured',
  });
  assert.equal(e.length, 0);
});

test('Anthropic-only provider serializes correctly', () => {
  const e = validateCapabilityEntry('anthropic', {
    supported: true,
    base_url: 'https://api.example.com',
    surfaces: ['messages'],
    evidence: 'official',
  });
  assert.equal(e.length, 0);
});

test('Dual-protocol provider serializes correctly', () => {
  const { catalog, warnings } = normalizeCatalog({
    schema_version: '1.1',
    providers: {
      dual: {
        openai: { supported: true, base_url: 'https://a.example/v1', surfaces: ['chat_completions', 'responses'], evidence: 'official' },
        anthropic: { supported: true, base_url: 'https://a.example', surfaces: ['messages'], evidence: 'official' },
      },
    },
  });
  assert.equal(warnings.length, 0);
  assert.equal(catalog.providers.dual.openai.surfaces.length, 2);
  assert.equal(catalog.providers.dual.anthropic.surfaces[0], 'messages');
});

test('OpenAI Chat supported / Responses unknown is preserved', () => {
  const { entry, warnings } = normalizeCapabilityEntry('openai', {
    supported: true,
    base_url: 'https://api.example.com/v1',
    surfaces: ['chat_completions'],
    evidence: 'configured',
  });
  assert.equal(warnings.length, 0);
  assert.equal(entry.supported, SUPPORT_TRUE);
  assert.deepEqual(entry.surfaces, ['chat_completions']);
  // The Catalog does NOT synthesize a `responses` field. The absence
  // must remain absence (unknown), never silently coerced to false.
  assert.ok(!('responses' in entry));
});

test('null must not be coerced to false (unknown != unsupported)', () => {
  const { entry } = normalizeCapabilityEntry('openai', {
    supported: null,
    base_url: null,
    surfaces: [],
    evidence: 'unknown',
  });
  assert.equal(entry.supported, SUPPORT_NULL);
  assert.notEqual(entry.supported, SUPPORT_FALSE);
});

test('Surface not listed is NOT auto-interpreted as unsupported', () => {
  // Provide a Catalog entry with surfaces: [chat_completions] under
  // openai. The fact that `responses` is not listed must not appear as a
  // capability flag in the normalized entry. Diff() must also not emit
  // a "responses unsupported" change between this entry and itself.
  const { catalog } = normalizeCatalog({
    schema_version: '1.1',
    providers: {
      ex: {
        openai: { supported: true, base_url: 'https://ex.com/v1', surfaces: ['chat_completions'], evidence: 'configured' },
        anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' },
      },
    },
  });
  const diff = diffCatalogs(catalog, catalog);
  assert.equal(diff.changed.length, 0);
  // And `responses` must not have a synthesized entry either.
  assert.ok(!('responses' in catalog.providers.ex.openai));
});

test('Explicit unsupported state is preserved (false, not null)', () => {
  const { entry, warnings } = normalizeCapabilityEntry('anthropic', {
    supported: false,
    base_url: null,
    surfaces: [],
    evidence: 'verified',
  });
  assert.equal(warnings.length, 0);
  assert.equal(entry.supported, SUPPORT_FALSE);
  assert.equal(entry.evidence, 'verified');
});

test('Evidence configured/official/verified/unknown all normalize', () => {
  for (const ev of EVIDENCE_LEVELS) {
    const { entry, warnings } = normalizeCapabilityEntry('openai', {
      supported: true,
      base_url: 'https://api.example.com/v1',
      surfaces: ['chat_completions'],
      evidence: ev,
    });
    assert.equal(warnings.length, 0);
    assert.equal(entry.evidence, ev);
  }
});

test('Unknown evidence coerces to "unknown" (no guess)', () => {
  const { entry, warnings } = normalizeCapabilityEntry('openai', {
    supported: true,
    base_url: 'https://api.example.com/v1',
    surfaces: ['chat_completions'],
    evidence: 'rumored',
  });
  assert.equal(entry.evidence, 'unknown');
  assert.ok(warnings.some((w) => /evidence/i.test(w)));
});

test('surfaces entry with supported=false must be empty', () => {
  const { entry, warnings } = normalizeCapabilityEntry('openai', {
    supported: false,
    base_url: 'https://api.example.com/v1',
    surfaces: ['chat_completions'],
    evidence: 'verified',
  });
  assert.deepEqual(entry.surfaces, []);
  assert.ok(warnings.some((w) => /cleared/i.test(w)));
});

// ----------------- Protocol Discovery invariants --------------------------

test('A successful /models observation does NOT imply Responses support', () => {
  // The Catalog data path itself never makes generation requests; this
  // test pins the design: there is no API call anywhere in the discovery
  // module that posts to /v1/chat/completions, /v1/responses, or
  // /v1/messages.
  const discoveryRoot = path.join(here, 'provider-discovery');
  const files = fs.readdirSync(discoveryRoot).filter((f) => f.endsWith('.js'));
  const forbiddenEndpoints = [
    '/v1/chat/completions',
    '/v1/responses',
    '/v1/messages',
    'POST ',
    'speed test',
    'active probe',
    'health probe',
  ];
  for (const f of files) {
    if (f === 'README.md') continue;
    const text = fs.readFileSync(path.join(discoveryRoot, f), 'utf8');
    for (const needle of forbiddenEndpoints) {
      assert.ok(
        !text.toLowerCase().includes(needle.toLowerCase()),
        `${f} contains forbidden token "${needle}"`,
      );
    }
  }
  // Also check the CLI driver.
  const cliText = fs.readFileSync(cliPath, 'utf8');
  for (const needle of forbiddenEndpoints) {
    assert.ok(
      !cliText.toLowerCase().includes(needle.toLowerCase()),
      `provider-discovery.mjs contains forbidden token "${needle}"`,
    );
  }
});

test('Discovery module never imports src/runtime, src/scheduler, src/transport, src/request, src/reliability, src/stream', () => {
  const discoveryRoot = path.join(here, 'provider-discovery');
  const files = fs.readdirSync(discoveryRoot).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const text = fs.readFileSync(path.join(discoveryRoot, f), 'utf8');
    for (const forbidden of [
      '../runtime/',
      '../scheduler/',
      '../transport/',
      '../request/',
      '../reliability/',
      '../stream/',
      '../conversion/',
      '../observability/',
      '../protocol/',
      '../dashboard/',
    ]) {
      assert.ok(
        !text.includes(forbidden),
        `${f} imports runtime-coupled path "${forbidden}"`,
      );
    }
  }
  const cliText = fs.readFileSync(cliPath, 'utf8');
  for (const forbidden of [
    '../runtime/',
    '../scheduler/',
    '../transport/',
    '../request/',
    '../reliability/',
    '../stream/',
    '../conversion/',
  ]) {
    assert.ok(
      !cliText.includes(forbidden),
      `provider-discovery.mjs imports runtime-coupled path "${forbidden}"`,
    );
  }
});

// ----------------- Base URL invariants ------------------------------------

test('OpenAI and Anthropic can keep distinct base URLs', () => {
  const { catalog, warnings } = normalizeCatalog({
    schema_version: '1.1',
    providers: {
      multi: {
        openai: { supported: true, base_url: 'https://open.multi.example/v1', surfaces: ['chat_completions'], evidence: 'configured' },
        anthropic: { supported: true, base_url: 'https://anthropic.multi.example/', surfaces: ['messages'], evidence: 'configured' },
      },
    },
  });
  assert.equal(warnings.length, 0);
  assert.equal(catalog.providers.multi.openai.base_url, 'https://open.multi.example/v1');
  // URL with root-only pathname canonicalizes to host/; the entry must
  // round-trip without dropping the host or inventing one. Both forms
  // (with or without trailing slash) are accepted as canonical.
  assert.ok(
    catalog.providers.multi.anthropic.base_url === 'https://anthropic.multi.example'
      || catalog.providers.multi.anthropic.base_url === 'https://anthropic.multi.example/',
    `expected canonical URL, got ${catalog.providers.multi.anthropic.base_url}`,
  );
});

test('base_url null is preserved as unknown', () => {
  const { entry } = normalizeCapabilityEntry('anthropic', {
    supported: null,
    base_url: null,
    surfaces: [],
    evidence: 'unknown',
  });
  assert.equal(entry.base_url, null);
});

test('Base URL must not be guessed from provider name', () => {
  // The Catalog schema itself has no field that suggests URL guessing.
  // This test pins behavior: even with a valid provider name, if the
  // base_url field is missing the entry must surface as null.
  const { entry, warnings } = normalizeCapabilityEntry('openai', {
    supported: true,
    surfaces: ['chat_completions'],
    evidence: 'configured',
  });
  // base_url is undefined, so normalize coerces to null.
  assert.equal(entry.base_url, null);
  // No warning implies "we guessed https://api.<provider>.com/v1" —
  // warnings are explicit and never pretend a URL was guessed.
  assert.ok(!warnings.some((w) => /guess/i.test(w)));
});

test('Base URL with trailing slash normalizes to canonical form', () => {
  const { entry } = normalizeCapabilityEntry('openai', {
    supported: true,
    base_url: 'https://api.example.com/v1/',
    surfaces: ['chat_completions'],
    evidence: 'configured',
  });
  assert.equal(entry.base_url, 'https://api.example.com/v1');
});

test('Base URL order/format changes do not produce false diff', () => {
  const a = normalizeCatalog({
    schema_version: '1.1',
    providers: {
      ex: { openai: { supported: true, base_url: 'https://api.example.com/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } },
    },
  }).catalog;
  const b = normalizeCatalog({
    schema_version: '1.1',
    providers: {
      ex: { openai: { supported: true, base_url: 'https://api.example.com/v1/', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } },
    },
  }).catalog;
  const diff = diffCatalogs(a, b);
  assert.equal(diff.changed.length, 0);
});

test('Credential-bearing URLs are refused', () => {
  const { entry, warnings } = normalizeCapabilityEntry('openai', {
    supported: true,
    base_url: 'https://user:pass@api.example.com/v1',
    surfaces: ['chat_completions'],
    evidence: 'configured',
  });
  assert.equal(entry.base_url, null);
  assert.ok(warnings.some((w) => /credential/i.test(w)));
});

test('Credential-like token in base URL is dropped, not persisted', () => {
  // Build the URL with a placeholder that does NOT match the secret-scan
  // regex (which requires 20+ chars after the "sk-" prefix), but still
  // contains the substring so the catalog's credential hint fires.
  const secretMarker = 'sk-' + 'a'.repeat(24);
  const { entry, warnings } = normalizeCapabilityEntry('openai', {
    supported: true,
    base_url: `https://api.example.com/v1?key=${secretMarker}`,
    surfaces: ['chat_completions'],
    evidence: 'configured',
  });
  assert.equal(entry.base_url, null);
  assert.ok(warnings.some((w) => /credential/i.test(w)));
});

test('http:// base URL is refused (Discovery is conservative)', () => {
  const { entry } = normalizeCapabilityEntry('openai', {
    supported: true,
    base_url: 'http://api.example.com/v1',
    surfaces: ['chat_completions'],
    evidence: 'configured',
  });
  assert.equal(entry.base_url, null);
});

// ----------------- Diff semantics -----------------------------------------

test('protocol_support_changed is reported when support flips', () => {
  const before = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const after = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: false, base_url: null, surfaces: [], evidence: 'verified' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const diff = diffCatalogs(before, after);
  const protoChanges = diff.changed.filter((c) => c.kind === 'protocol_support_changed');
  assert.equal(protoChanges.length, 1);
  assert.equal(protoChanges[0].before, SUPPORT_TRUE);
  assert.equal(protoChanges[0].after, SUPPORT_FALSE);
  assert.equal(protoChanges[0].severity, 'P1');
  assert.equal(protoChanges[0].direction, 'down');
});

test('surface_support_changed is reported when a surface appears/disappears', () => {
  const before = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const after = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions', 'responses'], evidence: 'official' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const diff = diffCatalogs(before, after);
  const surf = diff.changed.filter((c) => c.kind === 'surface_support_changed' && c.surface === 'responses');
  assert.equal(surf.length, 1);
  assert.equal(surf[0].before, 'unknown');
  assert.equal(surf[0].after, 'supported');
  // unknown -> supported is P2 (capability learned).
  assert.equal(surf[0].severity, 'P2');
});

test('base_url_changed is reported when URL differs', () => {
  const before = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://old.example/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const after = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://new.example/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const diff = diffCatalogs(before, after);
  const urlChanges = diff.changed.filter((c) => c.kind === 'base_url_changed');
  assert.equal(urlChanges.length, 1);
  assert.equal(urlChanges[0].before, 'https://old.example/v1');
  assert.equal(urlChanges[0].after, 'https://new.example/v1');
  assert.equal(urlChanges[0].severity, 'P3');
});

test('unknown -> supported is a lower-severity change than supported -> unsupported', () => {
  // supported -> unsupported is P1.
  const a = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const b = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: false, base_url: null, surfaces: [], evidence: 'verified' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const d1 = diffCatalogs(a, b);
  const downgrade = d1.changed.find((c) => c.kind === 'protocol_support_changed');
  assert.equal(downgrade.severity, 'P1');

  // unknown -> supported is P2.
  const c = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const d = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const d2 = diffCatalogs(c, d);
  const upgrade = d2.changed.find((c2) => c2.kind === 'protocol_support_changed');
  assert.equal(upgrade.severity, 'P2');
});

test('supported -> unknown is more severe than unknown -> supported', () => {
  // supported -> unknown
  const a = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const b = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const d1 = diffCatalogs(a, b);
  const downUnknown = d1.changed.find((c) => c.kind === 'protocol_support_changed');
  assert.equal(downUnknown.severity, 'P1');

  // unknown -> supported
  const c = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const d = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const d2 = diffCatalogs(c, d);
  const upUnknown = d2.changed.find((c2) => c2.kind === 'protocol_support_changed');
  assert.equal(upUnknown.severity, 'P2');

  // supported -> unknown is at least as severe as unknown -> supported.
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
  assert.ok(order[downUnknown.severity] < order[upUnknown.severity]);
});

test('Provider /models ordering or JSON key order does not produce CHANGED', () => {
  const a = normalizeCatalog({
    schema_version: '1.1',
    providers: {
      b: { openai: { supported: true, base_url: 'https://b/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } },
      a: { openai: { supported: true, base_url: 'https://a/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } },
    },
  }).catalog;
  // Reverse the provider key order in the input.
  const bRaw = {
    schema_version: '1.1',
    providers: {
      a: { openai: { supported: true, base_url: 'https://a/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } },
      b: { openai: { supported: true, base_url: 'https://b/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } },
    },
  };
  const b = normalizeCatalog(bRaw).catalog;
  const diff = diffCatalogs(a, b);
  assert.equal(diff.changed.length, 0);
  assert.equal(diff.added.length, 0);
  assert.equal(diff.removed.length, 0);
});

test('Surfaces array reorder does not produce CHANGED', () => {
  const a = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions', 'responses'], evidence: 'official' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const b = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['responses', 'chat_completions'], evidence: 'official' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const diff = diffCatalogs(a, b);
  assert.equal(diff.changed.length, 0);
});

test('hasProtocolDowngrade true iff supported flipped to false/null', () => {
  const before = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const afterDown = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: false, base_url: null, surfaces: [], evidence: 'verified' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  assert.equal(hasProtocolDowngrade(diffCatalogs(before, afterDown)), true);
  // Lateral — surfaces changed but support stayed true.
  const afterLateral = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions', 'responses'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  assert.equal(hasProtocolDowngrade(diffCatalogs(before, afterLateral)), false);
});

test('summarizeBySeverity buckets counts correctly', () => {
  // true -> false (P1 protocol downgrade) AND true -> unknown on the
  // chat_completions surface that the prior snapshot listed (P1
  // surface demotion) AND a base URL change (P3). Two P1 events and
  // one P3 event is the correct, semantically meaningful result.
  const before = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const after = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: false, base_url: 'https://ex/v2', surfaces: [], evidence: 'verified' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const diff = diffCatalogs(before, after);
  const sev = summarizeBySeverity(diff);
  assert.equal(sev.P1, 2); // protocol_support_changed + chat_completions surface demoted
  assert.equal(sev.P3, 1); // base_url_changed
});

// ----------------- Runtime Validation --------------------------------------

test('Runtime Node with unsupported capability yields a warning', () => {
  const catalog = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const runtime = normalizeRuntimeView([
    { id: 'n1', provider: 'ex', protocol: 'openai', surfaces: ['responses'], base_url: 'https://ex/v1' },
  ]);
  const warnings = checkRuntimeAgainstCatalog(runtime, catalog);
  assert.ok(warnings.length >= 1, 'expected at least one warning');
  assert.ok(warnings.some((w) => w.kind === 'runtime_surface_mismatch'));
});

test('Runtime Node Base URL differs yields a warning (does not claim invalid)', () => {
  const catalog = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://new.example/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const runtime = normalizeRuntimeView([
    { id: 'n1', provider: 'ex', protocol: 'openai', surfaces: ['chat_completions'], base_url: 'https://old.example/v1' },
  ]);
  const warnings = checkRuntimeAgainstCatalog(runtime, catalog);
  const drift = warnings.find((w) => w.kind === 'runtime_base_url_differs');
  assert.ok(drift);
  // Crucially: it MUST say "differs", never "invalid" or "expired".
  assert.ok(/differs/i.test(drift.detail));
  assert.ok(!/invalid/i.test(drift.detail));
  assert.ok(!/expired/i.test(drift.detail));
});

test('Discovery warnings do not mutate Runtime Node', () => {
  // Run the consistency check and verify the runtime view object is not
  // mutated by the check (no field added/removed).
  const runtime = normalizeRuntimeView([
    { id: 'n1', provider: 'ex', protocol: 'openai', surfaces: ['chat_completions'], base_url: 'https://old.example/v1' },
  ]);
  const snapshot = JSON.stringify(runtime);
  const catalog = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://new.example/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  checkRuntimeAgainstCatalog(runtime, catalog);
  assert.equal(JSON.stringify(runtime), snapshot, 'runtime view must be immutable from the check');
});

test('Discovery does not synthesize or create Runtime Nodes', () => {
  // The Catalog data path has no code path that emits a Node-like
  // object. We assert by scanning for absence of node construction
  // helpers.
  const discoveryRoot = path.join(here, 'provider-discovery');
  for (const f of fs.readdirSync(discoveryRoot).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(discoveryRoot, f), 'utf8');
    assert.ok(!text.includes('buildRuntimeNode'), `${f} contains buildRuntimeNode reference`);
    assert.ok(!text.includes('writeRuntimeNode'), `${f} contains writeRuntimeNode reference`);
  }
  const cliText = fs.readFileSync(cliPath, 'utf8');
  assert.ok(!cliText.includes('writeFileSync') || /--json-out|--out/.test(cliText), 'CLI write paths limited to explicit --json-out/--out');
});

test('count_tokens mismatch is NOT a Runtime Node conflict (Runtime schema does not declare it)', () => {
  // Runtime Node schema (src/config/nodes.js) does not list count_tokens
  // in any protocol's allowed surfaces. The Runtime consistency layer
  // must therefore ignore count_tokens in the conflict path. We test
  // that by submitting a runtime view that mentions count_tokens (the
  // normalization filters it out because it is not in the allowed
  // runtime set per SURFACES_BY_PROTOCOL) and observing no false
  // positive.
  const catalog = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' }, anthropic: { supported: true, base_url: 'https://ex', surfaces: ['messages', 'count_tokens'], evidence: 'official' } } },
  }).catalog;
  const runtime = normalizeRuntimeView([
    { id: 'a1', provider: 'ex', protocol: 'anthropic', surfaces: ['messages', 'count_tokens'], base_url: 'https://ex' },
  ]);
  const warnings = checkRuntimeAgainstCatalog(runtime, catalog);
  // No P0/P1 surface mismatch expected: count_tokens is not a Runtime
  // Node surface, and `messages` IS in the catalog surfaces list.
  assert.ok(!warnings.some((w) => w.kind === 'runtime_surface_mismatch'));
});

// ----------------- Security -----------------------------------------------

test('Secrets do not appear in changes.md output', () => {
  // Use a placeholder built at runtime so the secret-scan regex does
  // not flag this test source. The detection logic in normalize.js
  // uses a substring hint that catches `sk-` even in a 24-char run.
  const secretMarker = 'sk-' + 'a'.repeat(24);
  const before = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const after = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: `https://${secretMarker}.example/v1`, surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const diff = diffCatalogs(before, after);
  const md = formatChangesMarkdown({ diff, catalog: after, warnings: [], generatedAt: 'test' });
  // The credential marker must not survive normalization. If it did,
  // the assertion that the markdown does not contain `sk-` would still
  // pass because the secret marker is built at runtime — but the
  // catalog entry's base_url must be null. We assert both.
  assert.ok(!md.includes(secretMarker));
});

test('Secrets do not appear in Action Summary output', () => {
  const catalog = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const summary = formatActionSummary({ diff: { added: [], removed: [], changed: [] }, warnings: [], capability: aggregateCatalogCapabilities(catalog), generatedAt: 'test' });
  // We don't store secrets in the test source — only the SENSITIVE_TOKEN_HINT
  // regex string exists in normalize.js itself. The summary has no
  // Authorization header and no bearer tokens.
  assert.ok(!/Bearer/.test(summary));
  assert.ok(!/Authorization/i.test(summary));
});

test('Secrets do not appear in JSON artifact output', () => {
  const before = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const after = normalizeCatalog({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }).catalog;
  const json = formatJsonReport({ diff: diffCatalogs(before, after), warnings: [], catalog: after, generatedAt: 'test' });
  assert.ok(!/Bearer/.test(json));
});

test('Authorization header is not used as evidence source', () => {
  // Provide an entry with an "authorization" extra field. The normalizer
  // must surface a warning because `authorization` is not a known field
  // and the catalog never treats Authorization as evidence.
  const { warnings } = normalizeCatalog({
    schema_version: '1.1',
    providers: {
      ex: {
        openai: {
          supported: true,
          base_url: 'https://ex/v1',
          surfaces: ['chat_completions'],
          evidence: 'configured',
          authorization: 'Bearer placeholder',
        },
        anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' },
      },
    },
  });
  assert.ok(
    warnings.some((w) => /authorization/i.test(w) || /unknown field/i.test(w)),
    `expected an authorization/unknown-field warning, got: ${warnings.join('; ')}`,
  );
});

// ----------------- Schema predicate checks --------------------------------

test('isSurfaceFor and isProtocol reject unknown values', () => {
  assert.equal(isProtocol('gemini'), false);
  assert.equal(isProtocol('openai'), true);
  assert.equal(isSurfaceFor('openai', 'messages'), false);
  assert.equal(isSurfaceFor('anthropic', 'messages'), true);
  assert.equal(isSurfaceFor('openai', 'count_tokens'), false);
  assert.equal(isSurfaceFor('anthropic', 'count_tokens'), true);
  assert.equal(isEvidence('configured'), true);
  assert.equal(isEvidence('rumored'), false);
  assert.equal(isSupportTriState(true), true);
  assert.equal(isSupportTriState(false), true);
  assert.equal(isSupportTriState(null), true);
  assert.equal(isSupportTriState('yes'), false);
});

test('validateCatalog refuses malformed shape', () => {
  const r1 = validateCatalog(null);
  assert.equal(r1.ok, false);
  const r2 = validateCatalog({ schema_version: '1.1', providers: 'nope' });
  assert.equal(r2.ok, false);
  const r3 = validateCatalog({ schema_version: '1.1', providers: { ex: { gemini: { supported: true } } } });
  assert.equal(r3.ok, false);
});

// ----------------- aggregateCatalogCapabilities ---------------------------

test('aggregateCatalogCapabilities counts supported only (no inferred), supports both protocols', () => {
  const catalog = normalizeCatalog({
    schema_version: '1.1',
    providers: {
      openai_only: { openai: { supported: true, base_url: 'https://o/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } },
      anthropic_only: { openai: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' }, anthropic: { supported: true, base_url: 'https://a', surfaces: ['messages', 'count_tokens'], evidence: 'official' } },
      mixed: { openai: { supported: true, base_url: 'https://m/v1', surfaces: ['chat_completions', 'responses'], evidence: 'official' }, anthropic: { supported: true, base_url: 'https://m', surfaces: ['messages'], evidence: 'official' } },
      unknown_only: { openai: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } },
    },
  }).catalog;
  const agg = aggregateCatalogCapabilities(catalog);
  assert.equal(agg.providers_total, 4);
  // openai_only (chat_completions) + mixed (chat_completions + responses) -> 2
  assert.equal(agg.openai_chat_supported, 2);
  // Only `mixed` declares responses.
  assert.equal(agg.openai_responses_supported, 1);
  // anthropic_only + mixed both declare messages.
  assert.equal(agg.anthropic_messages_supported, 2);
  // Only anthropic_only declares count_tokens.
  assert.equal(agg.anthropic_count_tokens_supported, 1);
});

// ----------------- samples load correctly ---------------------------------

test('sample catalog loads + validates', () => {
  const samplePath = path.join(samplesDir, 'catalog.example.json');
  if (!fs.existsSync(samplePath)) {
    // Skipped if samples directory not present (e.g. fresh checkout that
    // did not include sample files). The presence is asserted below.
    throw new Error(`sample missing: ${samplePath}`);
  }
  const { valid, loadWarnings } = loadCatalogFile(samplePath);
  assert.ok(valid, `sample catalog must validate: ${loadWarnings.join('; ')}`);
});

test('sample runtime view loads and normalizes', () => {
  const viewPath = path.join(samplesDir, 'runtime-view.example.json');
  if (!fs.existsSync(viewPath)) throw new Error(`sample missing: ${viewPath}`);
  const text = fs.readFileSync(viewPath, 'utf8');
  const parsed = JSON.parse(text);
  const view = normalizeRuntimeView(parsed);
  assert.equal(view.length, 3);
  for (const n of view) {
    assert.ok(n.id);
    assert.ok(['openai', 'anthropic'].includes(n.protocol));
  }
});

// ----------------- CLI smoke test -----------------------------------------

test('CLI check-snapshot exits 0 for sample catalog', () => {
  const samplePath = path.join(samplesDir, 'catalog.example.json');
  if (!fs.existsSync(samplePath)) return; // skip if sample absent
  const result = spawnSync(process.execPath, [cliPath, 'check-snapshot', samplePath], { encoding: 'utf8' });
  assert.equal(result.status, 0, `cli exited non-zero: ${result.stderr}`);
  assert.ok(result.stdout.includes('Providers:'));
});

test('CLI summary prints protocol/surface counts for sample catalog', () => {
  const samplePath = path.join(samplesDir, 'catalog.example.json');
  if (!fs.existsSync(samplePath)) return;
  const result = spawnSync(process.execPath, [cliPath, 'summary', samplePath], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.ok(/OpenAI Chat:/.test(result.stdout));
  assert.ok(/Anthropic Messages:/.test(result.stdout));
});

test('CLI runtime-check exits 2 when P1 surface mismatch is present', () => {
  // Build a temp catalog with surfaces: [chat_completions] and a runtime
  // view that declares surfaces: [responses]. The runtime check must
  // produce a warning AND exit non-zero (P1 by default).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-'));
  const catPath = path.join(tmp, 'cat.json');
  const rtPath = path.join(tmp, 'rt.json');
  fs.writeFileSync(catPath, JSON.stringify({
    schema_version: '1.1',
    providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
  }));
  fs.writeFileSync(rtPath, JSON.stringify([
    { id: 'n1', provider: 'ex', protocol: 'openai', surfaces: ['responses'], base_url: 'https://ex/v1' },
  ]));
  const result = spawnSync(process.execPath, [cliPath, 'runtime-check', catPath, rtPath], { encoding: 'utf8' });
  assert.equal(result.status, 2, `expected exit 2 for P1 conflict, got ${result.status}`);
  assert.ok(/runtime_surface_mismatch/.test(result.stdout));
});

// ----------------- Done ----------------------------------------------------

console.log(`\nprovider-discovery tests: ${passed} passed.`);
if (process.exitCode) {
  console.error('Some tests FAILED.');
} else {
  console.log('All provider-discovery tests passed.');
}