// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// PROTOCOL_FALLBACKS: cross-protocol route fallback chains.
//
// Shape:
//   {
//     "anthropic:messages": ["openai:chat_completions"],
//     "openai:chat_completions": ["anthropic:messages"]
//   }
//
// Keys are "protocol:surface" pairs of the CLIENT route that the fallback
// triggers for; values are ordered arrays of "protocol:surface" pairs of
// alternative upstreams to try after the native pool is exhausted.
//
// When the gateway exhausts every native node for a request, the first
// matching fallback chain is consumed in order: each entry is attempted via
// the same scheduling / reliability / hedging / budget machinery as a native
// node, with cross-protocol request/response conversion applied at the
// boundary. Like POLICIES_CONFIG, parse errors and unknown surfaces are
// collected as warnings and the empty config is used in their place; the
// gateway is never marked invalid solely because of a typo here.

import { readEnv } from './env.js';

const PROTOCOL_SURFACES = new Map([
  ['openai', new Set(['chat_completions', 'responses'])],
  ['anthropic', new Set(['messages'])],
]);

const ROUTE_PROTOCOL_SURFACE = Object.freeze({
  openai_chat: 'openai:chat_completions',
  openai_responses: 'openai:responses',
  anthropic_messages: 'anthropic:messages',
});

let cachedEnv;
let cached;

export function loadProtocolFallbacks(env) {
  return analyzeProtocolFallbacks(env).config;
}

export function getProtocolFallbacksDiagnostics(env) {
  return analyzeProtocolFallbacks(env).errors;
}

function analyzeProtocolFallbacks(env) {
  if (cachedEnv === env && cached) return cached;
  cachedEnv = env;
  const raw = readEnv(env, 'PROTOCOL_FALLBACKS');
  const errors = [];
  const config = {};
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      errors.push(`PROTOCOL_FALLBACKS invalid JSON (${e.message}); fallbacks disabled`);
      cached = { config, errors };
      return cached;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('PROTOCOL_FALLBACKS must be a JSON object { "protocol:surface": ["protocol:surface", ...] }');
    } else {
      for (const [key, value] of Object.entries(parsed)) {
        const parsedKey = parseSurfaceKey(key, errors);
        if (!parsedKey) continue;
        if (!Array.isArray(value) || value.length === 0) {
          errors.push(`PROTOCOL_FALLBACKS: "${key}" must be a non-empty array of "protocol:surface" strings`);
          continue;
        }
        const targets = [];
        for (const entry of value) {
          const parsedEntry = parseSurfaceKey(entry, errors, key);
          if (parsedEntry) targets.push(parsedEntry);
        }
        if (targets.length > 0) config[parsedKey] = targets;
      }
    }
  }
  cached = { config, errors };
  return cached;
}

function parseSurfaceKey(raw, errors, parentKey) {
  const prefix = parentKey ? `PROTOCOL_FALLBACKS: "${parentKey}" entry` : 'PROTOCOL_FALLBACKS key';
  if (typeof raw !== 'string' || !raw.trim()) {
    errors.push(`${prefix} must be a non-empty "protocol:surface" string`);
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  const idx = trimmed.indexOf(':');
  if (idx <= 0 || idx === trimmed.length - 1) {
    errors.push(`${prefix} "${raw}" must be in the form "protocol:surface" (e.g. "anthropic:messages")`);
    return null;
  }
  const protocol = trimmed.slice(0, idx);
  const surface = trimmed.slice(idx + 1);
  const allowed = PROTOCOL_SURFACES.get(protocol);
  if (!allowed) {
    errors.push(`${prefix} "${raw}" has unknown protocol "${protocol}" (allowed: openai, anthropic)`);
    return null;
  }
  if (!allowed.has(surface)) {
    errors.push(`${prefix} "${raw}" has unknown surface "${surface}" for protocol "${protocol}" (allowed: ${[...allowed].join(', ')})`);
    return null;
  }
  return trimmed;
}

// Resolve the fallback chain for a given client route, in iteration order.
// Returns an array of { protocol, surface } objects (empty when no fallback
// is configured for the route). The route must be one of the natively
// supported routes (openai_chat / openai_responses / anthropic_messages).
export function getFallbackChain(route, env) {
  const key = ROUTE_PROTOCOL_SURFACE[route];
  if (!key) return [];
  const config = loadProtocolFallbacks(env);
  const chain = config[key];
  if (!chain || chain.length === 0) return [];
  return chain.map((entry) => {
    const idx = entry.indexOf(':');
    return { protocol: entry.slice(0, idx), surface: entry.slice(idx + 1) };
  });
}
