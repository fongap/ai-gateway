// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Tier 1 session affinity is a soft score bias. The deployed Worker has no
// session-sticky routing, so the binding is stored in KV and only cached
// briefly in isolate memory. Tier 2/3 never read or write this store.
//
// Memory safety: both the affinity cache and the escape counters use a
// bounded TTL map. A client that floods unique x-session-id values can never
// grow isolate memory unboundedly — expired entries are evicted first, then
// the oldest entries by insertion order (LRU-ish). The raw client Session ID
// is never stored as a Map key; a stable synchronous hash is used instead so
// no plaintext session ID lingers in isolate memory beyond the request scope.

import { TIER1_AFFINITY_FACTOR } from '../reliability/tier1-state.js';

const KV_BINDING = 'TIER1_AFFINITY';
const KEY_PREFIX = 'affinity:v1:';
const TTL_SECONDS = 30 * 60;
const CACHE_TTL_MS = 5_000;
const ESCAPE_CHECK_REQUESTS = 10;
const ESCAPE_CHECK_MS = 5 * 60_000;
const ESCAPE_THRESHOLD = 1.5;

// Capacity limits — internal constants, not user-facing knobs. The affinity
// cache holds recent KV lookups (5s TTL) so a few hundred entries covers a
// burst of concurrent sessions on a single isolate. The escape counter map
// tracks per-session request frequency; a few hundred is plenty for a single
// isolate's lifetime.
const CACHE_MAX_ENTRIES = 500;
const ESCAPE_MAX_ENTRIES = 500;

// ---- Bounded TTL Map ---------------------------------------------------------
// A minimal Map wrapper with TTL + max capacity + active cleanup. Eviction
// policy: expired entries first (any position), then oldest-inserted first
// (Map preserves insertion order in JS). No precise LRU — see the task spec:
// "不需要实现复杂精准 LRU".
class BoundedTtlMap {
  constructor(maxEntries, ttlMs) {
    this._map = new Map();
    this._max = maxEntries;
    this._ttlMs = ttlMs;
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this._map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    const expiresAt = Date.now() + (ttlMs ?? this._ttlMs);
    // If the key already exists, update in place (preserves insertion order).
    if (this._map.has(key)) {
      this._map.set(key, { value, expiresAt });
      return;
    }
    // Enforce capacity: sweep expired first, then evict oldest.
    if (this._map.size >= this._max) this._evict();
    this._map.set(key, { value, expiresAt });
  }

  delete(key) {
    this._map.delete(key);
  }

  clear() {
    this._map.clear();
  }

  get size() {
    return this._map.size;
  }

  _evict() {
    const now = Date.now();
    // Pass 1: delete all expired entries.
    for (const [k, e] of this._map) {
      if (e.expiresAt <= now) this._map.delete(k);
    }
    // If still at capacity, evict oldest-inserted entries (Map iteration is
    // insertion order). Remove ~10% to amortize the cost across requests.
    if (this._map.size >= this._max) {
      const toRemove = Math.max(1, Math.ceil(this._max * 0.1));
      let removed = 0;
      for (const k of this._map.keys()) {
        this._map.delete(k);
        if (++removed >= toRemove) break;
      }
    }
  }
}

const cache = new BoundedTtlMap(CACHE_MAX_ENTRIES, CACHE_TTL_MS);
// Escape counters have no natural TTL — they track request frequency per
// session. Use a generous TTL (same as the escape check window) so stale
// counters for sessions that stop sending are eventually cleaned up.
const escapeCounters = new BoundedTtlMap(ESCAPE_MAX_ENTRIES, ESCAPE_CHECK_MS);

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

// Synchronous non-cryptographic hash for the escape counter key. This avoids
// storing the raw client Session ID in isolate memory and does not require an
// async crypto call (shouldEvaluateAffinity is synchronous). FNV-1a 32-bit
// is sufficient — it only needs to be a stable, collision-resistant-enough
// derivation of the session ID, not a secret.
function sessionHash(sessionId) {
  const str = String(sessionId);
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return 'h' + (hash >>> 0).toString(16).padStart(8, '0');
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
  if (cached !== undefined) { return cached; }
  stats.reads++;
  let accountId = null;
  try {
    const value = await kv.get(key);
    if (typeof value === 'string' && value.length > 0 && value.length <= 64) accountId = value;
  } catch { /* affinity is advisory; a transient KV read failure yields no bias */ }
  if (accountId) stats.hits++; else stats.misses++;
  cache.set(key, accountId, CACHE_TTL_MS);
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
    cache.set(key, accountId, CACHE_TTL_MS);
    stats.writes++;
  })().catch(() => { stats.writeFailures++; });
  if (ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(operation); } catch { operation.catch(() => {}); }
  }
  return true;
}

export function shouldEvaluateAffinity(sessionId, now = Date.now()) {
  if (!sessionId) return false;
  const hashedKey = sessionHash(sessionId);
  const counter = escapeCounters.get(hashedKey);
  if (!counter) {
    escapeCounters.set(hashedKey, { requests: 1, lastCheck: now }, ESCAPE_CHECK_MS);
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
    cache_size: cache.size,
    escape_counters_size: escapeCounters.size,
    cache_max_entries: CACHE_MAX_ENTRIES,
    escape_max_entries: ESCAPE_MAX_ENTRIES,
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
