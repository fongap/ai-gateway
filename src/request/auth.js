// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Gateway access-key authentication. v1.2.7 governance model.
//
// Authorization flow:
//
//   Client presents a credential (Authorization: Bearer or x-api-key)
//     ↓
//   The credential is matched (constant-time SHA-256) against each
//   configured GATEWAY_ACCESS_KEY_<GROUP> secret.
//     ↓
//   On a hit, the resolved group and its model allowlist are returned.
//     ↓
//   The request handler calls authorizeModel() against the configured
//   logical model set BEFORE entering the scheduler.
//
// If no GATEWAY_ACCESS_KEY_<GROUP> is configured, the legacy single
// GATEWAY_ACCESS_KEY is honored (backward compatible). A misconfigured
// new key group never falls back to the legacy key.
//
// Raw secrets never leave this module. Only the low-cardinality group
// label is used in logs/stats.

import { loadAccessKeysConfig } from '../config/access-keys.js';

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
//   { authorized, mode, group?, allowAll, allowlist }
//
// `mode` is 'grouped' (new system), 'legacy' (GATEWAY_ACCESS_KEY), or 'none'.
// `group` is the credential group label ('AIR', 'PRO', 'MAX', 'ULTRA',
// 'AGENT', or 'LEGACY'). It is the only non-secret identifier used in logs.
// `allowlist` is a Set<string>; when undefined the key grants all models
// (legacy behaviour or explicit GATEWAY_ACCESS_MODELS_<GROUP>="*").
// `allowAll` is true when the group's allowlist is "*" (or legacy).
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
            mode: key.group === 'LEGACY' ? 'legacy' : 'grouped',
            group: key.group,
            allowAll: key.allowAll,
            allowlist: key.allowAll ? undefined : new Set(key.allowlist),
          };
        }
      }
    }
    return { authorized: false, mode: multi.anyNewKey ? 'grouped' : 'legacy' };
  }

  return { authorized: false, mode: 'none' };
}

// Backward-compatible shim: returns true/false only (legacy callers).
export async function isAuthorized(request, accessKey) {
  if (accessKey === undefined) {
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
