// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Gateway access-key authentication. The expected key is only ever compared as
// a cached SHA-256 digest with a constant-time comparison; presented candidates
// may arrive via Authorization: Bearer or x-api-key.

// Cached digest of the gateway access key (immutable per isolate).
let cachedAccessKey = null;
let cachedAccessKeyDigest = null;

function getAccessKeyDigest(accessKey) {
  if (cachedAccessKey === accessKey && cachedAccessKeyDigest) return Promise.resolve(cachedAccessKeyDigest);
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(accessKey ?? '')))
    .then((digest) => {
      cachedAccessKey = accessKey;
      cachedAccessKeyDigest = new Uint8Array(digest);
      return cachedAccessKeyDigest;
    });
}

function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}

// True when the request presents the gateway access key via either header.
export async function isAuthorized(request, accessKey) {
  const bearer = parseBearer(request.headers.get('authorization'));
  const xApiKey = String(request.headers.get('x-api-key') || '').trim();
  const presented = [];
  if (bearer) presented.push(bearer);
  if (xApiKey) presented.push(xApiKey);
  if (presented.length === 0) return false;
  // The expected digest is cached per isolate: one SHA-256 per request instead
  // of two, with the same either-header-matches semantics and a constant-time
  // comparison.
  const expected = await getAccessKeyDigest(accessKey);
  for (const candidate of presented) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(candidate));
    if (constantTimeEquals(new Uint8Array(digest), expected)) return true;
  }
  return false;
}

function parseBearer(value) {
  const raw = String(value || '').trim();
  return raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : raw;
}
