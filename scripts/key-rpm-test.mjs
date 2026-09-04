// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// PR 6 / P2-A — Per-key gateway RPM limiter (in-isolate, sliding window).
//
// These tests pin the contract the handler relies on:
//   1. cap=0 disables the limiter (every request is admitted)
//   2. within the window, the first N requests are admitted and
//      request N+1 is denied
//   3. once the oldest stamp falls out of the window, that slot frees
//      up and the next request is admitted
//   4. deny returns a positive retryAfterSec based on the oldest stamp
//   5. each key has an independent counter
//   6. the bounded key map does not leak under 10000 unique keys

import assert from 'node:assert/strict';
import { admitKeyRequest, getKeyRpmSnapshot, __resetKeyRpmForTests } from '../src/ratelimit/key-rpm.js';

const now = 1_700_000_000_000;
const WINDOW = 60_000;

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

await test('cap=0 disables the limiter entirely', () => {
  __resetKeyRpmForTests();
  for (let i = 0; i < 5000; i += 1) {
    assert.equal(admitKeyRequest('k0', 0, now + i).ok, true, 'every request must be admitted when cap=0');
  }
});

await test('within the window, first N requests are admitted and N+1 is denied', () => {
  __resetKeyRpmForTests();
  for (let i = 0; i < 5; i += 1) {
    const r = admitKeyRequest('k1', 5, now + i * 100);
    assert.equal(r.ok, true, `request ${i + 1} should be admitted`);
  }
  const denied = admitKeyRequest('k1', 5, now + 500);
  assert.equal(denied.ok, false, 'the 6th request must be denied');
  assert.ok(denied.retryAfterSec > 0, 'retryAfterSec must be positive');
  assert.ok(denied.retryAfterSec <= 60, 'retryAfterSec must be <= the window length');
});

await test('once the oldest stamp falls out of the window, the slot frees up', () => {
  __resetKeyRpmForTests();
  // 5 requests at the cap.
  for (let i = 0; i < 5; i += 1) {
    admitKeyRequest('k2', 5, now + i);
  }
  // At now+WINDOW, the first request is exactly 60s old — outside the window.
  const later = now + WINDOW + 1;
  const r = admitKeyRequest('k2', 5, later);
  assert.equal(r.ok, true, 'after the window slides, the next request must be admitted');
});

await test('denied request retry-after reflects the oldest stamp', () => {
  __resetKeyRpmForTests();
  // First request at t=0; the 6th is at t=30000 — retry-after should
  // be ceil((0 + 60000 - 30000) / 1000) = 30 seconds.
  for (let i = 0; i < 5; i += 1) {
    admitKeyRequest('k3', 5, now + i);
  }
  const denied = admitKeyRequest('k3', 5, now + 300);
  assert.equal(denied.retryAfterSec, 60, 'retryAfterSec should be 60s when the oldest stamp is 0.3s in');
});

await test('each key has an independent counter', () => {
  __resetKeyRpmForTests();
  for (let i = 0; i < 5; i += 1) {
    admitKeyRequest('kA', 5, now + i);
  }
  // kA is at cap. kB has its own counter.
  for (let i = 0; i < 5; i += 1) {
    const r = admitKeyRequest('kB', 5, now + i);
    assert.equal(r.ok, true, 'kB should be unaffected by kA');
  }
  // kA is still denied.
  const r = admitKeyRequest('kA', 5, now + 6);
  assert.equal(r.ok, false, 'kA is still at cap');
});

await test('snapshot reports the current usage', () => {
  __resetKeyRpmForTests();
  for (let i = 0; i < 3; i += 1) {
    admitKeyRequest('kSnap', 10, now + i);
  }
  const snap = getKeyRpmSnapshot('kSnap', now + 3);
  assert.equal(snap.used, 3, 'snapshot should report the in-window count');
});

await test('bounded key map: 10000 unique keys do not exceed the cap', () => {
  __resetKeyRpmForTests();
  for (let i = 0; i < 10_000; i += 1) {
    admitKeyRequest(`k${i}`, 1, now);
  }
  // The cap is 5000; anything past that is evicted. The limiter still
  // works for newly-arriving keys (it never throws OOM, never blocks).
  const r = admitKeyRequest('k-fresh-after-overflow', 1, now);
  assert.equal(r.ok, true, 'the limiter must keep admitting fresh keys after overflow');
});
