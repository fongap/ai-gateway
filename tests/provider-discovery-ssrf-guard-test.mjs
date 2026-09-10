#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// SSRF Guard tests for Provider Discovery security hardening.

import assert from 'node:assert/strict';
import {
  isDangerousHost,
  isSafeDiscoveryUrl,
  redirectTargetIsSafe,
  readBoundedResponseText,
  enforceMaxModelCount,
  DISCOVERY_LIMITS,
} from './ssrf-guard.js';

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
async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

// --- isDangerousHost ---

test('localhost is dangerous', () => {
  assert.ok(isDangerousHost('localhost'));
  assert.ok(isDangerousHost('LOCALHOST'));
  assert.ok(isDangerousHost('localhost.localdomain'));
});

test('loopback IPs are dangerous', () => {
  assert.ok(isDangerousHost('127.0.0.1'));
  assert.ok(isDangerousHost('127.0.0.5'));
  assert.ok(isDangerousHost('::1'));
  assert.ok(isDangerousHost('[::1]'));
});

test('link-local IPv4 (metadata) is dangerous', () => {
  assert.ok(isDangerousHost('169.254.169.254'));
  assert.ok(isDangerousHost('169.254.0.1'));
});

test('private RFC1918 IPs are dangerous', () => {
  assert.ok(isDangerousHost('10.0.0.1'));
  assert.ok(isDangerousHost('192.168.1.1'));
  assert.ok(isDangerousHost('172.16.0.1'));
  assert.ok(isDangerousHost('172.31.255.254'));
  assert.ok(isDangerousHost('100.64.0.1'));
  assert.ok(isDangerousHost('100.127.255.255'));
});

test('link-local IPv6 is dangerous', () => {
  assert.ok(isDangerousHost('fe80::1'));
  assert.ok(isDangerousHost('fc00::1'));
  assert.ok(isDangerousHost('fd00::1'));
});

test('cloud metadata hostnames are dangerous', () => {
  assert.ok(isDangerousHost('metadata.google.internal'));
  assert.ok(isDangerousHost('metadata'));
});

test('wildcard bind addresses are dangerous', () => {
  assert.ok(isDangerousHost('0.0.0.0'));
  assert.ok(isDangerousHost('::'));
});

test('public safe hosts pass', () => {
  assert.ok(!isDangerousHost('api.example.com'));
  assert.ok(!isDangerousHost('1.2.3.4'));
  assert.ok(!isDangerousHost('2001:db8::1'));
});

// --- isSafeDiscoveryUrl ---

test('safe HTTPS URL passes', () => {
  const r = isSafeDiscoveryUrl('https://api.example.com/v1');
  assert.ok(r.safe);
  assert.equal(r.reason, null);
});

test('HTTP is rejected', () => {
  const r = isSafeDiscoveryUrl('http://api.example.com/v1');
  assert.ok(!r.safe);
  assert.ok(r.reason.includes('must use https'));
});

test('userinfo is rejected', () => {
  const r = isSafeDiscoveryUrl('https://user:pass@api.example.com/v1');
  assert.ok(!r.safe);
  assert.ok(r.reason.includes('userinfo'));
});

test('SSRF targets are rejected', () => {
  for (const url of [
    'https://localhost:443',
    'https://127.0.0.1:443',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.1:443',
    'https://metadata.google.internal',
  ]) {
    const r = isSafeDiscoveryUrl(url);
    assert.ok(!r.safe, `${url} should be rejected`);
    assert.ok(r.reason.includes('blocked host'));
  }
});

test('allowPrivate opt-in permits private IPs', () => {
  const r = isSafeDiscoveryUrl('https://10.0.0.1:443', true);
  assert.ok(r.safe);
});

test('invalid URL format rejected', () => {
  const r = isSafeDiscoveryUrl('not-a-url');
  assert.ok(!r.safe);
  assert.ok(r.reason.includes('invalid URL'));
});

// --- redirectTargetIsSafe ---

test('redirect revalidation blocks dangerous targets', () => {
  assert.ok(!redirectTargetIsSafe('https://169.254.169.254'));
  assert.ok(!redirectTargetIsSafe('https://localhost'));
  assert.ok(!redirectTargetIsSafe('http://api.example.com'));
  assert.ok(redirectTargetIsSafe('https://api.example.com/new'));
});

// --- enforceMaxModelCount ---

test('model count limit enforced', () => {
  const models = Array.from({ length: 1001 }, (_, i) => ({ id: `m${i}` }));
  assert.throws(() => enforceMaxModelCount(models, 1000), /max 1000/);
  const ok = enforceMaxModelCount(models.slice(0, 1000), 1000);
  assert.equal(ok.length, 1000);
});

// --- readBoundedResponseText ---

function makeMockResponse(bodyText) {
  const encoder = new TextEncoder();
  const data = encoder.encode(bodyText);
  return {
    body: {
      getReader() {
        let first = true;
        return {
          async read() {
            if (first) {
              first = false;
              return { done: false, value: data };
            }
            return { done: true, value: undefined };
          },
          cancel() {},
        };
      },
    },
    text: async () => bodyText,
  };
}

testAsync('response under limit passes', async () => {
  const res = makeMockResponse('hello');
  const text = await readBoundedResponseText(res, 1000);
  assert.equal(text, 'hello');
});

testAsync('response over limit throws', async () => {
  const res = makeMockResponse('x'.repeat(1000));
  await assert.rejects(readBoundedResponseText(res, 100), /exceeds 100/);
});

// --- DISCOVERY_LIMITS constants ---

test('DISCOVERY_LIMITS has expected defaults', () => {
  assert.equal(DISCOVERY_LIMITS.connectTimeoutMs, 10_000);
  assert.equal(DISCOVERY_LIMITS.responseTimeoutMs, 30_000);
  assert.equal(DISCOVERY_LIMITS.maxResponseBytes, 5 * 1024 * 1024);
  assert.equal(DISCOVERY_LIMITS.maxModelCount, 1_000);
  assert.equal(DISCOVERY_LIMITS.maxRedirects, 3);
});

console.log(`\nssrf-guard tests: ${passed} passed.`);
if (process.exitCode) {
  console.error('Some tests FAILED.');
} else {
  console.log('All ssrf-guard tests passed.');
}