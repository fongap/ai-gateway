// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Gateway access-key authentication.
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
// If no GATEWAY_ACCESS_KEY_<GROUP> is configured, no credential is accepted.
// Raw secrets never leave this module. Only the low-cardinality group label
// is used in logs/stats.

import { loadAccessKeysConfig } from '../config/access-keys.ts';
import type { AuthResult } from '../types/request.ts';

export type { AuthResult };

function sha256Digest(text: unknown): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text ?? '')));
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}

function parseBearer(value: string | null | undefined): string {
  const raw = String(value || '').trim();
  if (!raw.toLowerCase().startsWith('bearer ')) return '';
  const token = raw.slice(7).trim();
  return token || '';
}

function presentedCredentials(request: Request): string[] {
  const bearer = parseBearer(request.headers.get('authorization'));
  const xApiKey = String(request.headers.get('x-api-key') || '').trim();
  const presented: string[] = [];
  if (bearer) presented.push(bearer);
  if (xApiKey) presented.push(xApiKey);
  return presented;
}

// Resolve the request to an auth result (see AuthResult).
export async function authorize(request: Request, env: Record<string, unknown>): Promise<AuthResult> {
  const presented = presentedCredentials(request);
  if (presented.length === 0) return { authorized: false, mode: 'none' };

  const access = loadAccessKeysConfig(env);
  if (access.keys.length === 0) return { authorized: false, mode: 'none' };

  const candidateDigests = await Promise.all(presented.map((c) => sha256Digest(c)));
  for (const key of access.keys) {
    if (!key.secret) continue;
    const expected = await sha256Digest(key.secret);
    for (const candidate of candidateDigests) {
      if (constantTimeEquals(new Uint8Array(candidate), new Uint8Array(expected))) {
        return {
          authorized: true,
          mode: 'grouped',
          group: key.group,
          allowAll: key.allowAll,
          allowlist: key.allowAll ? undefined : new Set(key.allowlist),
        };
      }
    }
  }

  return { authorized: false, mode: 'grouped' };
}
