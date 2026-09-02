// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Gateway access-key authentication. Supports two modes:
//
//   1. Multi-key (ACCESS_KEYS_CONFIG present): the presented credential is
//      matched against each declared key's secret (constant-time). On a hit
//      the resolved key_id and model allowlist are returned.
//   2. Legacy single key (GATEWAY_ACCESS_KEY only): full access, backward
//      compatible.
//
// Presented candidates may arrive via Authorization: Bearer or x-api-key.
// The expected secrets are only ever compared as SHA-256 digests with a
// constant-time comparison; raw secrets never leave this module.

import { loadAccessKeysConfig } from '../config/access-keys.js';

// Legacy single-key digest cache (immutable per isolate).
let cachedAccessKey = null;
let cachedAccessKeyDigest = null;

function sha256Digest(text) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text ?? '')));
}

function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}

function getLegacyAccessKeyDigest(accessKey) {
  if (cachedAccessKey === accessKey && cachedAccessKeyDigest) return Promise.resolve(cachedAccessKeyDigest);
  return sha256Digest(accessKey).then((digest) => {
    cachedAccessKey = accessKey;
    cachedAccessKeyDigest = new Uint8Array(digest);
    return cachedAccessKeyDigest;
  });
}

function parseBearer(value) {
  const raw = String(value || '').trim();
  if (!raw.toLowerCase().startsWith('bearer ')) return '';
  const token = raw.slice(7).trim();
  return token || '';
}

function presentedCredentials(request) {
  const bearer = parseBearer(request.headers.get('authorization'));
  const xApiKey = String(request.headers.get('x-api-key') || '').trim();
  const presented = [];
  if (bearer) presented.push(bearer);
  if (xApiKey) presented.push(xApiKey);
  return presented;
}

// Resolve the request to an auth result:
//   { authorized, keyId?, allowAll?, allowlist?, mode }
//
// `mode` is 'multi' (ACCESS_KEYS_CONFIG) or 'legacy' (GATEWAY_ACCESS_KEY).
// `allowlist` is a Set<string>; when undefined the key grants all models
// (legacy behaviour or explicit models:["*"]).
export async function authorize(request, env) {
  const presented = presentedCredentials(request);
  if (presented.length === 0) return { authorized: false, mode: 'none' };

  const multi = loadAccessKeysConfig(env);
  if (multi.keys.length > 0) {
    const candidateDigests = await Promise.all(presented.map((c) => sha256Digest(c)));
    for (const key of multi.keys) {
      if (!key.secret) continue;
      const expected = await sha256Digest(key.secret);
      for (const candidate of candidateDigests) {
        if (constantTimeEquals(new Uint8Array(candidate), new Uint8Array(expected))) {
          return {
            authorized: true,
            mode: 'multi',
            keyId: key.key_id,
            allowAll: key.allowAll,
            allowlist: key.allowAll ? undefined : new Set(key.allowlist),
          };
        }
      }
    }
    return { authorized: false, mode: 'multi' };
  }

  // Legacy single-key fallback.
  const accessKey = typeof env?.GATEWAY_ACCESS_KEY === 'string' ? env.GATEWAY_ACCESS_KEY : '';
  if (!accessKey) return { authorized: false, mode: 'none' };
  const expected = await getLegacyAccessKeyDigest(accessKey);
  for (const candidate of presented) {
    const digest = await sha256Digest(candidate);
    if (constantTimeEquals(new Uint8Array(digest), expected)) {
      return { authorized: true, mode: 'legacy', allowAll: true };
    }
  }
  return { authorized: false, mode: 'legacy' };
}

// Backward-compatible shim: returns true/false only (legacy callers).
export async function isAuthorized(request, accessKey) {
  if (accessKey === undefined) {
    // Best-effort path for callers that no longer pass an accessKey; the full
    // resolver is `authorize()`. This shim is retained only for the version
    // endpoint which is exempt from auth.
    return false;
  }
  const legacyDigest = await getLegacyAccessKeyDigest(accessKey);
  const presented = presentedCredentials(request);
  if (presented.length === 0) return false;
  for (const candidate of presented) {
    const digest = await sha256Digest(candidate);
    if (constantTimeEquals(new Uint8Array(digest), legacyDigest)) return true;
  }
  return false;
}
