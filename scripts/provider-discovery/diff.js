// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Semantic diff between two normalized Provider Discovery Catalogs.
//
// Result shape (sorted, key-order-independent):
//
//   {
//     added:     [ { provider, kind, protocol, surface? } ],
//     removed:   [ ... ],
//     changed:   [
//       {
//         provider,
//         kind: 'protocol_support_changed'
//             | 'surface_support_changed'
//             | 'base_url_changed',
//         protocol, surface?, before, after,
//         severity: 'P0' | 'P1' | 'P2' | 'P3',
//         direction: 'down' | 'lateral' | 'up'
//       }
//     ],
//     unchanged_providers: [ ... ]   // informational only, not surfaced in changes.md
//   }
//
// Severity rules (see §十二 of v1.1):
//   P0  Runtime-used protocol/surface became unsupported (caller compares
//        against the runtime view to decide; pure catalog diff returns P1)
//   P1  supported -> unsupported                  (capability downgraded)
//       supported -> unknown                      (capability demoted)
//   P2  unknown   -> supported                    (capability learned)
//       unsupported -> supported                  (capability learned)
//       Missing provider capability now present   (model entry gain)
//       Confirmed removal of a model entry         (model entry loss -> P1)
//   P3  Metadata-only changes (evidence, base_url difference without
//       provider capability shift, surface array reorder)
//
// The catalog diff itself only knows about capability-level shifts. The
// `direction` field distinguishes "down" (lost capability) from "up"
// (gained capability). The runtime-vs-catalog conflict layer maps P1
// down-shifts that touch runtime-used surfaces into P0.

import {
  PROTOCOLS,
  SURFACES_BY_PROTOCOL,
  SUPPORT_TRUE,
  SUPPORT_FALSE,
  SUPPORT_NULL,
} from './catalog-schema.js';

// Map a before/after pair of tri-state support values into a coarse
// direction. `null` is treated as "unknown" semantically; transitions
// involving `null` are always "lateral" — we never want to claim that
// `unknown -> true` is operationally equivalent to `false -> true`.
function directionOf(before, after) {
  const toRank = (v) => (v === SUPPORT_TRUE ? 2 : v === SUPPORT_FALSE ? 0 : 1);
  const rb = toRank(before);
  const ra = toRank(after);
  if (ra > rb) return 'up';
  if (ra < rb) return 'down';
  return 'lateral';
}

function severityForTransition(kind, before, after) {
  // base_url_changed is metadata. It is P3 unless the caller (runtime
  // check) explicitly escalates it because the old endpoint is known to
  // be dead. That escalation happens in runtime-check.js, NOT here.
  if (kind === 'base_url_changed') return { severity: 'P3', direction: 'lateral' };

  // support / surface capability transitions.
  const dir = directionOf(before, after);
  // supported -> unsupported   P1
  // supported -> unknown       P1
  // unknown   -> supported     P2
  // unsupported -> supported   P2
  // anything else involving null on either end: P2 (no firm claim)
  if (before === SUPPORT_TRUE && (after === SUPPORT_FALSE || after === SUPPORT_NULL)) {
    return { severity: 'P1', direction: 'down' };
  }
  if (before === SUPPORT_NULL && after === SUPPORT_TRUE) {
    return { severity: 'P2', direction: 'up' };
  }
  if (before === SUPPORT_FALSE && after === SUPPORT_TRUE) {
    return { severity: 'P2', direction: 'up' };
  }
  // default: lateral metadata drift
  return { severity: 'P3', direction: dir };
}

// Return the canonical key for a provider+protocol+surface triple used to
// detect entry-level changes.
function pkey(provider, protocol, surface) {
  return surface ? `${provider}|${protocol}|${surface}` : `${provider}|${protocol}`;
}

// Compare two capability entries for an optional surface. Returns a list
// of change objects (zero or more).
function compareCapabilityEntry(provider, protocol, before, after) {
  const out = [];
  if (!before && !after) return out;

  // Protocol-level support transition.
  const bSup = before?.supported ?? SUPPORT_NULL;
  const aSup = after?.supported ?? SUPPORT_NULL;
  if (bSup !== aSup) {
    const { severity, direction } = severityForTransition('protocol_support_changed', bSup, aSup);
    out.push({
      provider,
      kind: 'protocol_support_changed',
      protocol,
      before: bSup,
      after: aSup,
      severity,
      direction,
    });
  }

  // Base URL transition (only meaningful when at least one side is a
  // non-null string and they differ).
  const bUrl = before?.base_url ?? null;
  const aUrl = after?.base_url ?? null;
  if (bUrl !== aUrl) {
    const { severity, direction } = severityForTransition('base_url_changed', null, null);
    out.push({
      provider,
      kind: 'base_url_changed',
      protocol,
      before: bUrl,
      after: aUrl,
      severity,
      direction,
    });
  }

  // Surface-level transitions. Surfaces are *added* or *removed* sets;
  // surface-level support tracks the protocol's supported state for that
  // surface. When the protocol flips, surfaces are reported separately
  // so that the report can say "X was supported on Y surface before" or
  // vice-versa.
  const bSurfaces = new Set(before?.surfaces ?? []);
  const aSurfaces = new Set(after?.surfaces ?? []);
  const known = SURFACES_BY_PROTOCOL[protocol] || [];
  for (const surface of known) {
    const wasListed = bSurfaces.has(surface);
    const isListed = aSurfaces.has(surface);
    if (wasListed === isListed) continue;
    // The surface-level "support" claim inherits the protocol's claim.
    // When the surface appears, before=true / after=true; when it
    // disappears, before=true / after=null (unknown) — NOT false. We
    // intentionally refuse to claim `false` here per v1.1 §四: a
    // missing surface means the Catalog has not confirmed support.
    const beforeState = wasListed ? SUPPORT_TRUE : SUPPORT_NULL;
    const afterState = isListed ? SUPPORT_TRUE : SUPPORT_NULL;
    const { severity, direction } = severityForTransition('surface_support_changed', beforeState, afterState);
    out.push({
      provider,
      kind: 'surface_support_changed',
      protocol,
      surface,
      before: wasListed ? 'supported' : 'unknown',
      after: isListed ? 'supported' : 'unknown',
      severity,
      direction,
    });
  }

  return out;
}

export function diffCatalogs(before, after) {
  const bProviders = before?.providers || {};
  const aProviders = after?.providers || {};
  const names = new Set([...Object.keys(bProviders), ...Object.keys(aProviders)]);
  const sortedNames = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const added = [];
  const removed = [];
  const changed = [];
  const unchangedProviders = [];

  for (const provider of sortedNames) {
    const bProv = bProviders[provider];
    const aProv = aProviders[provider];

    // Provider-level added/removed: emit a synthetic capability change so
    // that downstream severity logic still works uniformly.
    if (bProv && !aProv) {
      removed.push({ provider, kind: 'protocol_support_changed', protocol: '*', before: SUPPORT_TRUE, after: SUPPORT_NULL, severity: 'P1', direction: 'down' });
      continue;
    }
    if (!bProv && aProv) {
      added.push({ provider, kind: 'protocol_support_changed', protocol: '*', before: SUPPORT_NULL, after: SUPPORT_TRUE, severity: 'P2', direction: 'up' });
      continue;
    }

    let providerHadChange = false;
    const protocols = new Set([...Object.keys(bProv || {}), ...Object.keys(aProv || {})]);
    for (const protocol of protocols) {
      if (!PROTOCOLS.includes(protocol)) continue;
      const bEntry = bProv[protocol];
      const aEntry = aProv[protocol];
      const entryChanges = compareCapabilityEntry(provider, protocol, bEntry, aEntry);
      if (entryChanges.length > 0) {
        providerHadChange = true;
        changed.push(...entryChanges);
      }
    }
    if (!providerHadChange) unchangedProviders.push(provider);
  }

  // Stable sort by provider, then protocol, then kind/surface.
  const sortFn = (a, b) => {
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
    if ((a.protocol || '') !== (b.protocol || '')) return (a.protocol || '') < (b.protocol || '') ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    const sa = a.surface || '';
    const sb = b.surface || '';
    if (sa !== sb) return sa < sb ? -1 : 1;
    return 0;
  };
  added.sort(sortFn);
  removed.sort(sortFn);
  changed.sort(sortFn);
  unchangedProviders.sort();

  return {
    added,
    removed,
    changed,
    unchanged_providers: unchangedProviders,
    summary: {
      added_count: added.length,
      removed_count: removed.length,
      changed_count: changed.length,
      unchanged_count: unchangedProviders.length,
    },
  };
}

// Count changes by severity bucket.
export function summarizeBySeverity(diff) {
  const out = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const c of diff.changed) out[c.severity] = (out[c.severity] || 0) + 1;
  out.added = diff.added.length;
  out.removed = diff.removed.length;
  return out;
}

// Convenience: did this diff contain a downgrade of a protocol that is
// declared `true` in the catalog today? Used by the runtime check to
// decide whether to escalate to P0.
export function hasProtocolDowngrade(diff) {
  return diff.changed.some(
    (c) => c.kind === 'protocol_support_changed' && c.before === SUPPORT_TRUE && (c.after === SUPPORT_FALSE || c.after === SUPPORT_NULL),
  );
}

export { pkey };