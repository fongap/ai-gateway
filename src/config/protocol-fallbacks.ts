// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// PROTOCOL_FALLBACKS: cross-protocol route fallback chains.
//
// Shape:
//   {
//     "anthropic:messages": ["openai:chat_completions"]
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
// boundary.
//
// Modes:
//   (1) unset / empty string  -> built-in default chain (Default ON).
//   (2) "disable" (case-insensitive) -> empty config (legacy Native Only).
//   (3) JSON object            -> parsed verbatim; any parse error or
//                                unsupported target is a blocking config
//                                error. An explicit JSON value ALWAYS
//                                overrides the default — there is no silent
//                                merge. `{"anthropic:messages":[]}` is a
//                                valid operator choice that means "explicitly
//                                turn off fallback for this route".
//
// Rationale for Default ON: the only supported conversion
// (Anthropic Messages -> OpenAI Chat Completions) is the safe and widely-
// expected fallback for Anthropic-only operators who also carry an OpenAI-
// compatible pool. Operators who want the legacy behavior can opt out with
// `PROTOCOL_FALLBACKS=disable`.
//
// Only explicitly supported conversions are allowed. Unsupported conversions
// produce blocking configuration errors (not warnings).

import { readEnv } from './env.ts';
import type { Protocol, Surface } from '../types/protocol.ts';

const PROTOCOL_SURFACES = new Map<string, Set<string>>([
  ['openai', new Set(['chat_completions', 'responses'])],
  ['anthropic', new Set(['messages'])],
]);

// Single source of truth for supported cross-protocol conversions.
// Key: client route (protocol:surface), Value: array of allowed fallback targets.
// A conversion is listed here ONLY after the full Request + Response + Stream +
// Error Converter has been implemented and tested. See R0 of the v1.3.0
// development instructions.
export const SUPPORTED_CONVERSIONS: Readonly<Record<string, string[]>> = Object.freeze({
  'anthropic:messages': ['openai:chat_completions'],
  'openai:chat_completions': ['anthropic:messages'],
  'openai:responses': ['anthropic:messages'],
});

// Built-in default chain. Applied when PROTOCOL_FALLBACKS is unset/empty.
// The default is the only one allowed without an explicit operator JSON
// value; see header for the three-mode contract.
export const DEFAULT_FALLBACK_CHAIN: Readonly<Record<string, string[]>> = Object.freeze({
  'anthropic:messages': ['openai:chat_completions'],
  'openai:chat_completions': ['anthropic:messages'],
  'openai:responses': ['anthropic:messages'],
});

// Magic literal that turns the default off. Compared case-insensitively after
// trimming surrounding whitespace.
const DISABLE_LITERAL = 'disable';

const ROUTE_PROTOCOL_SURFACE: Readonly<Record<string, string>> = Object.freeze({
  openai_chat: 'openai:chat_completions',
  openai_responses: 'openai:responses',
  anthropic_messages: 'anthropic:messages',
});

let cachedEnv: Record<string, unknown> | undefined;
let cached: { config: Record<string, string[]>, errors: string[] } | undefined;

export function loadProtocolFallbacks(env: Record<string, unknown>): Record<string, string[]> {
  return analyzeProtocolFallbacks(env).config;
}

export function getProtocolFallbacksDiagnostics(env: Record<string, unknown>): string[] {
  return analyzeProtocolFallbacks(env).errors;
}

function analyzeProtocolFallbacks(env: Record<string, unknown>): { config: Record<string, string[]>, errors: string[] } {
  if (cachedEnv === env && cached) return cached;
  cachedEnv = env;
  const raw = readEnv(env, 'PROTOCOL_FALLBACKS');
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  const errors: string[] = [];
  const config: Record<string, string[]> = {};
  // Mode (1): unset / empty -> built-in default chain (Default ON).
  if (!trimmed) {
    cached = { config: { ...DEFAULT_FALLBACK_CHAIN }, errors };
    return cached;
  }
  // Mode (2): explicit opt-out -> legacy Native Only.
  if (trimmed.toLowerCase() === DISABLE_LITERAL) {
    cached = { config, errors };
    return cached;
  }
  // Mode (3): explicit JSON value — overrides the default verbatim, even if
  // it ends up empty. Parse errors are still blocking; an operator typo is
  // a config bug, not an excuse to silently fall back to the default.
  {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`PROTOCOL_FALLBACKS invalid JSON (${msg}); fallbacks disabled`);
      cached = { config, errors };
      return cached;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('PROTOCOL_FALLBACKS must be a JSON object { "protocol:surface": ["protocol:surface", ...] }');
    } else {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const parsedKey = parseSurfaceKey(key, errors, '');
        if (!parsedKey) continue;
        if (!Array.isArray(value)) {
          errors.push(`PROTOCOL_FALLBACKS: "${key}" must be a JSON array of "protocol:surface" strings`);
          continue;
        }
        // Empty array is a valid operator choice — it pins this route to
        // "off" while leaving the rest of the operator's config alone. The
        // route key is preserved (with an empty target list) so
        // getFallbackChain() can tell "explicitly turned off" from "no entry
        // at all". This is what makes the Default-ON contract safe: an
        // operator can always pin a single route to off without giving up
        // the rest of the default.
        if (value.length === 0) {
          config[parsedKey] = [];
          continue;
        }
        const targets: string[] = [];
        for (const entry of value) {
          const parsedEntry = parseSurfaceKey(String(entry), errors, key);
          if (parsedEntry) targets.push(parsedEntry);
        }
        if (targets.length > 0) {
          const allowed = SUPPORTED_CONVERSIONS[parsedKey];
          if (!allowed) {
            errors.push(`PROTOCOL_FALLBACKS: "${parsedKey}" is not a supported conversion source (supported: ${Object.keys(SUPPORTED_CONVERSIONS).join(', ')})`);
          } else {
            for (const target of targets) {
              if (!allowed.includes(target)) {
                errors.push(`PROTOCOL_FALLBACKS: "${parsedKey}" -> "${target}" is not a supported conversion (allowed: ${allowed.join(', ')})`);
              }
            }
          }
          // Only add valid targets (those that pass SUPPORTED_CONVERSIONS check)
          const validTargets = targets.filter((t) => allowed?.includes(t));
          if (validTargets.length > 0) config[parsedKey] = validTargets;
        }
      }
    }
  }
  cached = { config, errors };
  return cached;
}

function parseSurfaceKey(raw: string, errors: string[], parentKey: string): string | null {
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
export function getFallbackChain(route: string, env: Record<string, unknown>): Array<{ protocol: Protocol, surface: Surface }> {
  const key = ROUTE_PROTOCOL_SURFACE[route];
  if (!key) return [];
  const config = loadProtocolFallbacks(env);
  const chain = config[key];
  if (!chain || chain.length === 0) return [];
  // Entries are validated at parse time against the closed protocol/surface
  // sets, so the slice results honor the Protocol/Surface unions.
  return chain.map((entry) => {
    const idx = entry.indexOf(':');
    return {
      protocol: entry.slice(0, idx) as Protocol,
      surface: entry.slice(idx + 1) as Surface,
    };
  });
}
