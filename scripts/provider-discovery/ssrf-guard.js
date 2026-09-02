// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// SSRF defense for Provider Discovery.
//
// Governance (v1.2.6): when users only supply Base URL + API Key, Discovery's
// network entry point is the most dangerous surface. This module centralizes:
//
//   * Hostname/IP blocklist: localhost, loopback, link-local, cloud metadata
//     (169.254.169.254), private/RFC-1918 addresses, and obviously invalid
//     hostnames — rejected unless explicitly opted in for trusted private
//     providers via ALLOW_PRIVATE_DISCOVERY.
//   * Redirect re-validation: a public URL that 302s to 169.254.x.x must be
//     blocked; the target is re-checked through the same guard.
//   * Resource limits: connect timeout, response timeout, maximum response
//     size, maximum model count, maximum redirect count.
//
// This module is framework-agnostic and usable from both the offline
// normalizer (hostname checks on base_url strings) and any future live-fetch
// path (redirect + size + count enforcement on a fetch Response).

// ---------- host / IP blocklist ------------------------------------------

const LOOPBACK_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

function isLoopbackHostname(host) {
  const h = String(host || '').toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return true;
  // Bare loopback IPs.
  if (h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
  // 127.0.0.0/8
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

function isLinkLocalIpv4(host) {
  // 169.254.0.0/16 — includes the cloud metadata service 169.254.169.254.
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isPrivateIpv4(host) {
  // RFC 1918 + CGNAT 100.64/10.
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const m = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

function isLinkLocalIpv6(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|]$/g, '');
  return h.startsWith('fe80:') || h === '::' || h.startsWith('fc') || h.startsWith('fd');
}

// True when the host is a dangerous SSRF target.
export function isDangerousHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|]$/g, '');
  if (!h) return true;
  if (isLoopbackHostname(h)) return true;
  if (isLinkLocalIpv4(h)) return true;
  if (isPrivateIpv4(h)) return true;
  if (isLinkLocalIpv6(h)) return true;
  // Cloud metadata service by name.
  if (h === 'metadata.google.internal' || h === 'metadata') return true;
  // 0.0.0.0 / wildcard binding.
  if (h === '0.0.0.0' || h === '::') return true;
  return false;
}

// True when a URL string is safe to contact for Discovery. Returns
// { safe, reason } so callers can surface a diagnostic.
export function isSafeDiscoveryUrl(raw, allowPrivate = false) {
  if (typeof raw !== 'string') return { safe: false, reason: 'not a string' };
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return { safe: false, reason: 'invalid URL' };
  }
  if (u.protocol !== 'https:') return { safe: false, reason: 'must use https' };
  if (u.username || u.password) return { safe: false, reason: 'userinfo forbidden' };
  const host = u.hostname;
  if (!host) return { safe: false, reason: 'missing host' };
  if (!allowPrivate && isDangerousHost(host)) {
    return { safe: false, reason: `blocked host "${host}" (loopback/link-local/private/metadata)` };
  }
  return { safe: true, reason: null };
}

// ---------- resource limits -----------------------------------------------

export const DISCOVERY_LIMITS = Object.freeze({
  connectTimeoutMs: 10_000,
  responseTimeoutMs: 30_000,
  maxResponseBytes: 5 * 1024 * 1024, // 5 MiB
  maxModelCount: 1_000,
  maxRedirects: 3,
});

// Re-validate a redirect target through the same SSRF guard. Returns true when
// following the redirect is permitted.
export function redirectTargetIsSafe(locationHeader, allowPrivate = false) {
  if (typeof locationHeader !== 'string' || !locationHeader.trim()) return false;
  return isSafeDiscoveryUrl(locationHeader, allowPrivate).safe;
}

// Enforce a maximum response size on a fetch Response body. Returns the text,
// or throws when the body exceeds the limit. This prevents a malicious or
// buggy provider from streaming an unbounded response.
export async function readBoundedResponseText(response, maxBytes = DISCOVERY_LIMITS.maxResponseBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    // No streaming body (or not a Response) — fall back to text() but still
    // cap it.
    const text = await response.text();
    if (text.length > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
    return text;
  }
  let received = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      try { reader.cancel(); } catch { /* ignore */ }
      throw new Error(`response exceeds ${maxBytes} bytes (received ${received})`);
    }
    chunks.push(value);
  }
  // Concatenate Uint8Array chunks (works in Node.js and browsers).
  const total = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    total.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(total);
}

// Enforce a maximum model count on a parsed /models JSON payload.
export function enforceMaxModelCount(models, max = DISCOVERY_LIMITS.maxModelCount) {
  if (!Array.isArray(models)) return models;
  if (models.length > max) {
    throw new Error(`provider returned ${models.length} models (max ${max})`);
  }
  return models;
}
