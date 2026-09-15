// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyRemote } from '../scripts/github-deployment-config.mjs';
import { readFileSync } from 'node:fs';

test('online verification rejects the wrong Worker build before accepting health', async () => {
  const original = globalThis.fetch;
  const expected = 'a'.repeat(40);
  const shortGrace = { graceMs: 100, intervalMs: 10 };
  let calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    if (url.endsWith('/health')) return Response.json({ ready: true, build: 'b'.repeat(40) });
    return Response.json({});
  };
  try {
    await assert.rejects(verifyRemote('https://gateway.example', 'test-placeholder', expected, shortGrace), /does not match/);
    assert.ok(calls.filter((url) => url.endsWith('/health')).length >= 2, 'expected build-propagation retries');

    calls = [];
    globalThis.fetch = async url => {
      calls.push(url);
      if (url.endsWith('/health')) return Response.json({ ready: true, build: expected });
      return Response.json({});
    };
    await verifyRemote('https://gateway.example', 'test-placeholder', expected, shortGrace);
    assert.equal(calls.length, 3, 'build verification reuses the health probe');

    calls = [];
    await verifyRemote('https://gateway.example', 'test-placeholder');
    assert.equal(calls.length, 3, 'rollback probes health without asserting a target SHA');
  } finally { globalThis.fetch = original; }
});

test('manual deployment gate includes types and links; rollback verification follows successful rollback', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.match(pkg.scripts['validate:deploy'], /npm run typecheck/);
  assert.match(pkg.scripts['validate:deploy'], /npm run check:links/);
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /health-check --from-env --expected-build "\$DEPLOYED_SHA"/);
  assert.match(workflow, /Verify rolled-back gateway\s+if: failure\(\) && steps\.rollback\.outcome == 'success'/);
});
