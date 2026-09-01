// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Provider Discovery Catalog schema (v1.1).
//
// This file declares the *shape* of a Provider Capability Catalog and the
// narrow set of allowed values. The Catalog is an external-observation
// artefact maintained alongside (NOT inside) Runtime Node configuration.
//
// Boundary:
//   Runtime Node Config = production fact
//   Discovery Catalog   = external observation / auxiliary fact
//
// Nothing in this module touches src/runtime/*, src/scheduler/*,
// src/transport/*, src/request/*, src/reliability/*, or src/stream/*.
// Discovery is intentionally a read-only observer.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- core enums ----------------------------------------------------

// Only two protocol families exist; mirroring the gateway boundary so that
// the Catalog cannot accidentally invent a third.
export const PROTOCOLS = Object.freeze(['openai', 'anthropic']);

// The set of well-known client surfaces, grouped by the protocol that owns
// them. A surface MUST belong to its declared protocol.
//
//   openai      -> chat_completions | responses
//   anthropic   -> messages | count_tokens
//
// `count_tokens` is included as a Discovery capability because the runtime
// ANTHROPIC_COUNT_TOKENS_MODE knob exists and can be sourced from the
// provider, but Runtime Node schema (src/config/nodes.js) does NOT yet
// declare it as a `surfaces` entry. The runtime check therefore treats
// count_tokens as advisory-only unless and until the Runtime schema is
// extended; the Catalog can still record it.
export const SURFACES_BY_PROTOCOL = Object.freeze({
  openai: Object.freeze(['chat_completions', 'responses']),
  anthropic: Object.freeze(['messages', 'count_tokens']),
});

// The set of Runtime Node surfaces currently declared by the runtime schema.
// Used by the runtime mismatch check to decide which capabilities participate
// in Runtime-vs-Catalog conflict detection. count_tokens is intentionally
// excluded here because Runtime Node `surfaces` does not yet list it; doing
// so keeps Runtime warning semantics aligned with the actual schema instead
// of inventing a conflict that the runtime cannot model.
export const RUNTIME_NODE_SURFACES = Object.freeze([
  'chat_completions',
  'responses',
  'messages',
]);

// Evidence levels. Order matches the strictness of claim; `configured`
// means "an operator put this here", `official` means "the provider
// documented this", `verified` means "Discovery checked via a safe
// metadata endpoint", `unknown` means "no reliable source".
//
// We deliberately do NOT collapse these in the data path: a `configured`
// capability is still just a configured capability until somebody checks.
// `verified` must NEVER be claimed by a code path that performs a
// generation / model-inference request — only safe metadata calls.
export const EVIDENCE_LEVELS = Object.freeze([
  'configured',
  'official',
  'verified',
  'unknown',
]);

// Three-valued support. `true` = supported, `false` = verified-unsupported,
// `null` = unknown (catalog has not been able to confirm either way).
// Surface entries that are not listed under a supported protocol are treated
// as `null` (unknown), NOT as `false` (unsupported). See normalize.js.
export const SUPPORT_TRUE = true;
export const SUPPORT_FALSE = false;
export const SUPPORT_NULL = null;

// ---------- catalog shape -------------------------------------------------

// Canonical entry shape for one protocol inside one provider:
//
//   {
//     supported: true | false | null,
//     base_url:  string | null, // absolute https URL or null
//     surfaces:  string[],       // subset of SURFACES_BY_PROTOCOL[protocol]
//     evidence:  'configured' | 'official' | 'verified' | 'unknown',
//   }
//
// Constraints enforced by validateCatalog (see below):
//   - supported === true  => surfaces may be [] (catalog has no surface info yet)
//   - supported === false => surfaces MUST be []
//   - supported === null  => surfaces MUST be []
//   - base_url must be a string or null, never an empty string
//   - every listed surface MUST belong to the declared protocol
//   - evidence MUST be one of EVIDENCE_LEVELS
export const CAPABILITY_ENTRY_FIELDS = Object.freeze(['supported', 'base_url', 'surfaces', 'evidence']);

// The Catalog is keyed by provider name (string).
//
//   {
//     "schema_version": "1.1",
//     "providers": {
//       "<provider>": {
//         "openai":    { ... },
//         "anthropic": { ... }
//       }
//     }
//   }
export const CATALOG_SCHEMA_VERSION = '1.1';

// ---------- predicates ----------------------------------------------------

export function isProtocol(value) {
  return typeof value === 'string' && PROTOCOLS.includes(value);
}

export function isSurfaceFor(protocol, surface) {
  if (!isProtocol(protocol)) return false;
  const list = SURFACES_BY_PROTOCOL[protocol];
  return list.includes(surface);
}

export function isEvidence(value) {
  return typeof value === 'string' && EVIDENCE_LEVELS.includes(value);
}

// True iff the value is one of the three allowed support states.
export function isSupportTriState(value) {
  return value === SUPPORT_TRUE || value === SUPPORT_FALSE || value === SUPPORT_NULL;
}

// ---------- pure structural validation ------------------------------------

// Validate a single protocol entry inside a provider. Returns an array of
// human-readable error strings (empty = valid). Does not throw — the caller
// decides whether a malformed entry is fatal or merely flagged.
export function validateCapabilityEntry(protocol, entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return [`entry is not an object`];
  }
  for (const key of Object.keys(entry)) {
    if (!CAPABILITY_ENTRY_FIELDS.includes(key)) {
      errors.push(`unknown field "${key}"`);
    }
  }
  if (!isSupportTriState(entry.supported)) {
    errors.push(`supported must be true, false, or null`);
  }
  if (entry.base_url !== null && typeof entry.base_url !== 'string') {
    errors.push(`base_url must be a string or null`);
  }
  if (typeof entry.base_url === 'string' && entry.base_url.length === 0) {
    errors.push(`base_url must not be an empty string (use null instead)`);
  }
  if (!Array.isArray(entry.surfaces)) {
    errors.push(`surfaces must be an array`);
  } else {
    if (entry.supported === SUPPORT_FALSE && entry.surfaces.length > 0) {
      errors.push(`surfaces must be [] when supported is false`);
    }
    if (entry.supported === SUPPORT_NULL && entry.surfaces.length > 0) {
      errors.push(`surfaces must be [] when supported is null`);
    }
    const known = SURFACES_BY_PROTOCOL[protocol] || [];
    for (const surface of entry.surfaces) {
      if (typeof surface !== 'string') {
        errors.push(`surfaces entries must be strings`);
        break;
      }
      if (!known.includes(surface)) {
        errors.push(`surface "${surface}" is not valid for protocol "${protocol}" (allowed: ${known.join(', ')})`);
      }
    }
  }
  if (!isEvidence(entry.evidence)) {
    errors.push(`evidence must be one of ${EVIDENCE_LEVELS.join(', ')}`);
  }
  return errors;
}

// Validate the whole catalog. Returns { ok, errors }.
export function validateCatalog(catalog) {
  const errors = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return { ok: false, errors: ['catalog is not an object'] };
  }
  if (catalog.schema_version !== CATALOG_SCHEMA_VERSION) {
    errors.push(`schema_version must be "${CATALOG_SCHEMA_VERSION}"`);
  }
  if (!catalog.providers || typeof catalog.providers !== 'object' || Array.isArray(catalog.providers)) {
    errors.push('providers must be an object keyed by provider name');
    return { ok: errors.length === 0, errors };
  }
  for (const [providerName, providerEntry] of Object.entries(catalog.providers)) {
    if (!providerName.trim()) {
      errors.push('provider name must be a non-empty string');
      continue;
    }
    if (!providerEntry || typeof providerEntry !== 'object' || Array.isArray(providerEntry)) {
      errors.push(`provider "${providerName}" must be an object keyed by protocol`);
      continue;
    }
    for (const protocol of Object.keys(providerEntry)) {
      if (!isProtocol(protocol)) {
        errors.push(`provider "${providerName}": unknown protocol "${protocol}" (allowed: ${PROTOCOLS.join(', ')})`);
        continue;
      }
      const entry = providerEntry[protocol];
      const entryErrors = validateCapabilityEntry(protocol, entry);
      for (const e of entryErrors) errors.push(`provider "${providerName}" protocol "${protocol}": ${e}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------- file loading --------------------------------------------------

// Load a catalog JSON file from disk. Throws on malformed JSON. Validation
// is performed but only WARNED about (catalog may be partial in v1.1 — an
// operator may legitimately ship a `null`/unknown-only snapshot and refine
// it over time). Returned shape:
//
//   { catalog, loadWarnings: string[] }
export function loadCatalogFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`failed to parse catalog JSON at ${filePath}: ${e.message}`);
  }
  const { ok, errors } = validateCatalog(parsed);
  return { catalog: parsed, loadWarnings: ok ? [] : errors, valid: ok };
}

// ---------- path helper ---------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_DIR = here;