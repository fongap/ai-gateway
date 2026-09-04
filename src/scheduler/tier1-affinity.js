// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Tier 1 session affinity is a soft score bias. The deployed Worker has no
// session-sticky routing, so the binding is stored in KV and only cached
// briefly in isolate memory. Tier 2/3 never read or write this store.

import { TIER1_AFFINITY_FACTOR } from '../reliability/tier1-state.js';

const KV_BINDING = 'TIER1_AFFINITY';
const KEY_PREFIX = 'affinity:v1:';
const TTL_SECONDS = 30 * 60;
const CACHE_TTL_MS = 5_000;
const ESCAPE_CHECK_REQUESTS = 10;
const ESCAPE_CHECK_MS = 5 * 60_000;
const ESCAPE_THRESHOLD = 1.5;

const cache = new Map();
const escapeCounters = new Map();
const stats = {
  reads: 0, hits: 0, misses: 0, writes: 0, writeFailures: 0,
  selections: 0, selectionHits: 0, escapes: 0,
};

function kvOf(env) {
  const kv = env?.[KV_BINDING];
  return kv && typeof kv.get === 'function' && typeof kv.put === 'function' ? kv : null;
}

async function affinityKey(sessionId) {
  const bytes = new TextEncoder().encode(sessionId);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return KEY_PREFIX + hash;
}

export function resolveTier1SessionId(request) {
  const raw = request?.headers?.get?.('x-session-id');
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return id.length >= 8 && id.length <= 128 ? id : null;
}

export async function readTier1Affinity(env, sessionId) {
  if (!sessionId) return null;
  const kv = kvOf(env);
  if (!kv) return null;
  const key = await affinityKey(sessionId);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached?.expiresAt > now) return cached.accountId;
  stats.reads++;
  let accountId = null;
  try {
    const value = await kv.get(key);
    if (typeof value === 'string' && value.length > 0 && value.length <= 64) accountId = value;
  } catch { /* affinity is advisory; a transient KV read failure yields no bias */ }
  if (accountId) stats.hits++; else stats.misses++;
  cache.set(key, { accountId, expiresAt: now + CACHE_TTL_MS });
  return accountId;
}

// Called only for a cold session's first Tier 1 success or a successful
// migration. Repeated successes on the same account perform no KV write.
export function writeTier1Affinity(env, ctx, sessionId, accountId) {
  const kv = kvOf(env);
  if (!sessionId || !accountId || !kv) return false;
  const operation = (async () => {
    const key = await affinityKey(sessionId);
    await kv.put(key, accountId, { expirationTtl: TTL_SECONDS });
    cache.set(key, { accountId, expiresAt: Date.now() + CACHE_TTL_MS });
    stats.writes++;
  })().catch(() => { stats.writeFailures++; });
  if (ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(operation); } catch { operation.catch(() => {}); }
  }
  return true;
}

export function shouldEvaluateAffinity(sessionId, now = Date.now()) {
  if (!sessionId) return false;
  const counter = escapeCounters.get(sessionId);
  if (!counter) {
    escapeCounters.set(sessionId, { requests: 1, lastCheck: now });
    return false;
  }
  counter.requests++;
  if (counter.requests >= ESCAPE_CHECK_REQUESTS || now - counter.lastCheck >= ESCAPE_CHECK_MS) {
    counter.requests = 0;
    counter.lastCheck = now;
    return true;
  }
  return false;
}

export function affinityShouldEscape(affinityScore, winnerScore) {
  return Number.isFinite(affinityScore) && Number.isFinite(winnerScore)
    && affinityScore > winnerScore * ESCAPE_THRESHOLD;
}

export function tier1AffinityFactor(accountId, affinityAccountId) {
  return affinityAccountId && accountId === affinityAccountId ? TIER1_AFFINITY_FACTOR : 1;
}

export function recordTier1AffinityDecision({ affinityHit = false, escaped = false } = {}) {
  stats.selections++;
  if (affinityHit) stats.selectionHits++;
  if (escaped) stats.escapes++;
}

export function snapshotTier1Affinity(env) {
  return {
    storage: 'kv',
    binding: KV_BINDING,
    available: Boolean(kvOf(env)),
    key_format: 'sha256',
    ttl_seconds: TTL_SECONDS,
    ...stats,
  };
}

export function __resetTier1AffinityForTests() {
  cache.clear();
  escapeCounters.clear();
  Object.assign(stats, {
    reads: 0, hits: 0, misses: 0, writes: 0, writeFailures: 0,
    selections: 0, selectionHits: 0, escapes: 0,
  });
}
