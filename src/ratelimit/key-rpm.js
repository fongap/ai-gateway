// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Per-key in-isolate sliding-window rate limiter for the gateway
// access key. Single-isolate, in-memory; same model as
// node-state.js's RPM bucket. The cap is enforced before any
// upstream work happens, so an abused key never gets to consume a
// tier node's slot.
//
// For an account-wide / multi-isolate cap, bind a Cloudflare Rate
// Limiting worker binding (the QUOTA_RATE_LIMITER path) — this
// module is intentionally simple and per-isolate so it can run
// without any extra infrastructure.
//
// Design:
//   * window is 60s, ring of timestamps for the active window;
//   * the cap is set via the GATEWAY_KEY_RPM env var; 0 disables;
//   * the limiter is keyed on the gateway key fingerprint (NOT the
//     raw key) so it does not store credentials anywhere;
//   * a denied request returns 429 with Retry-After: <seconds until
//     the oldest stamp falls out of the window>;
//   * bounded by the number of distinct keys the gateway has seen
//     in the current isolate — the map is capped and old keys are
//     evicted.

/**
 * @typedef {{
 *   stamps: number[],
 *   lastSeen: number,
 * }} KeyStateEntry
 */

/** @typedef {{ ok: true } | { ok: false, retryAfterSec: number }} KeyAdmissionVerdict */

const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 5_000;

/** @type {Map<string, KeyStateEntry>} */
const keyState = new Map();

/**
 * @param {number} now
 */
function evictStale(now) {
  if (keyState.size <= MAX_TRACKED_KEYS) return;
  // Drop the entry with the smallest lastSeen (oldest un-observed key).
  /** @type {[string, KeyStateEntry] | null} */
  let oldest = null;
  for (const [k, v] of keyState) {
    if (oldest === null || v.lastSeen < oldest[1].lastSeen) oldest = [k, v];
  }
  if (oldest) keyState.delete(oldest[0]);
}

/**
 * @param {number[]} stamps
 * @param {number} now
 */
function pruneWindow(stamps, now) {
  const cutoff = now - WINDOW_MS;
  let drop = 0;
  while (drop < stamps.length && stamps[drop] < cutoff) drop += 1;
  if (drop > 0) stamps.splice(0, drop);
}

/**
 * Try to admit one request from `keyFingerprint` against the per-key
 * RPM cap. Returns { ok: true } when admitted, or { ok: false, retryAfterSec }
 * when the cap is exceeded.
 *
 * `keyFingerprint` is the opaque key id (NOT the raw credential) — see
 * `auth.js` for how the fingerprint is derived.
 *
 * `cap` is the RPM cap (0 = disabled). `now` is injectable for tests.
 *
 * @param {string} keyFingerprint
 * @param {number} cap
 * @param {number} [now]
 * @returns {KeyAdmissionVerdict}
 */
export function admitKeyRequest(keyFingerprint, cap, now = Date.now()) {
  if (!cap || cap <= 0) return { ok: true };
  let entry = keyState.get(keyFingerprint);
  if (!entry) {
    entry = { stamps: [], lastSeen: now };
    keyState.set(keyFingerprint, entry);
    evictStale(now);
  }
  pruneWindow(entry.stamps, now);
  entry.lastSeen = now;
  if (entry.stamps.length >= cap) {
    const oldest = entry.stamps[0];
    const retryAfterMs = Math.max(1, oldest + WINDOW_MS - now);
    return { ok: false, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
  }
  entry.stamps.push(now);
  return { ok: true };
}

/**
 * @param {string} keyFingerprint
 * @param {number} [now]
 * @returns {{ used: number, cap: number }}
 */
export function getKeyRpmSnapshot(keyFingerprint, now = Date.now()) {
  const entry = keyState.get(keyFingerprint);
  if (!entry) return { used: 0, cap: 0 };
  pruneWindow(entry.stamps, now);
  return { used: entry.stamps.length, cap: 0 };
}

export function __resetKeyRpmForTests() {
  keyState.clear();
}
