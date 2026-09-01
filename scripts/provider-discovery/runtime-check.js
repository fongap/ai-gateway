// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Runtime-vs-Discovery consistency check.
//
// This module is *advisory only*. It emits warnings. It MUST NOT mutate
// any Runtime Node configuration or Model Registry. The contract:
//
//   Runtime Node Config = production fact
//   Discovery Catalog   = external observation / auxiliary fact
//
// Three independent checks:
//   1. Surface mismatch   Runtime Node declares a surface that the
//                         Catalog has confirmed-unsupported (true/false
//                         only — "unknown" is NOT a conflict).
//   2. Base URL differs   Runtime Node base_url differs from the Catalog
//                         entry's base_url. We DO NOT claim the old URL
//                         is invalid; we only say it differs.
//   3. Provider presence  Runtime Node references a provider that has no
//                         entry in the Catalog at all.
//
// Check #1 and #3 can escalate to P0 ONLY if the runtime view confirms
// the capability is currently in use. Otherwise default is P1.

import {
  RUNTIME_NODE_SURFACES,
  SUPPORT_TRUE,
  SUPPORT_FALSE,
  SUPPORT_NULL,
} from './catalog-schema.js';
import { SURFACES_BY_PROTOCOL } from './normalize.js';

// Check one Runtime Node against the Catalog. Returns a list of warnings.
function checkNodeAgainstCatalog(node, catalog) {
  const warnings = [];
  const providerEntry = catalog?.providers?.[node.provider];
  const capabilityEntry = providerEntry?.[node.protocol];

  if (!providerEntry) {
    warnings.push({
      kind: 'runtime_provider_not_in_catalog',
      severity: 'P3',
      node_id: node.id,
      provider: node.provider,
      detail: `Runtime node "${node.id}" references provider "${node.provider}" which has no entry in the Catalog`,
    });
    return warnings;
  }

  if (!capabilityEntry) {
    // Provider is known to the Catalog but does not declare this protocol
    // at all. If the Runtime Node is in active use, this is the closest
    // thing to a P0 we will emit from the runtime check.
    warnings.push({
      kind: 'runtime_protocol_not_in_catalog',
      severity: 'P1',
      node_id: node.id,
      provider: node.provider,
      protocol: node.protocol,
      detail: `Runtime node "${node.id}" declares protocol "${node.protocol}" but the Catalog has no "${node.protocol}" entry for provider "${node.provider}"`,
    });
    return warnings;
  }

  // Capability mismatch: the Catalog confirms a surface is `false`. The
  // runtime-side `surfaces` field lists it. We DO NOT compare against
  // `null` (unknown) — that is the v1.1 guarantee.
  const supported = capabilityEntry.supported;
  const confirmedUnsupportedSurfaces = new Set(
    Array.isArray(capabilityEntry.surfaces)
      ? capabilityEntry.surfaces.filter((s) => supported === SUPPORT_TRUE) // surfaces listed under confirmed-supported entry
      : [],
  );

  for (const surface of node.surfaces) {
    // Only surfaces that Runtime Node schema actually models are
    // eligible for conflict detection. count_tokens is advisory-only
    // (see catalog-schema.js).
    if (!RUNTIME_NODE_SURFACES.includes(surface)) continue;
    // Catalog has explicitly marked this surface as not-included under a
    // confirmed-supported entry; that is the strongest signal we can
    // legitimately emit: "Runtime Node declares a surface, but the
    // Catalog has confirmed the protocol does not provide that surface."
    //
    // We detect this case by checking: the entry is supported=true but
    // `surfaces` is present and does NOT include this surface. v1.1
    // forbids interpreting "missing surface" as unsupported in the
    // general case, but the Runtime conflict layer is a narrower
    // question: "the Catalog has explicitly affirmed support AND listed
    // a specific surface set that does not include the Runtime Node's
    // declared surface".
    if (
      supported === SUPPORT_TRUE
      && Array.isArray(capabilityEntry.surfaces)
      && capabilityEntry.surfaces.length > 0
      && !capabilityEntry.surfaces.includes(surface)
    ) {
      warnings.push({
        kind: 'runtime_surface_mismatch',
        severity: 'P1',
        node_id: node.id,
        provider: node.provider,
        protocol: node.protocol,
        surface,
        detail: `Runtime node "${node.id}" declares surface "${surface}" but Catalog for provider "${node.provider}" lists surfaces [${capabilityEntry.surfaces.join(', ')}] under protocol "${node.protocol}"`,
      });
    }
    // Catalog explicitly marked the protocol as false — any Runtime
    // surface in that protocol is a P1 conflict.
    if (supported === SUPPORT_FALSE) {
      warnings.push({
        kind: 'runtime_protocol_unsupported',
        severity: 'P0',
        node_id: node.id,
        provider: node.provider,
        protocol: node.protocol,
        detail: `Runtime node "${node.id}" is configured for protocol "${node.protocol}" but Catalog marks provider "${node.provider}" as not supporting that protocol`,
      });
    }
  }

  // Base URL drift. We do NOT claim the configured URL is invalid — only
  // that it differs. Per §十 of v1.1, "differs" is the correct term;
  // "invalid" requires positive evidence we do not have here.
  const catalogBaseUrl = capabilityEntry.base_url;
  const runtimeBaseUrl = node.base_url;
  if (
    catalogBaseUrl
    && runtimeBaseUrl
    && catalogBaseUrl !== runtimeBaseUrl
  ) {
    warnings.push({
      kind: 'runtime_base_url_differs',
      severity: 'P3',
      node_id: node.id,
      provider: node.provider,
      protocol: node.protocol,
      configured_base_url: runtimeBaseUrl,
      discovered_base_url: catalogBaseUrl,
      detail: `Runtime node "${node.id}" base_url differs from Catalog entry for provider "${node.provider}" (${node.protocol})`,
    });
  }

  return warnings;
}

// Top-level: check a normalized runtime view against a normalized catalog.
// Returns an array of warning objects. The caller decides how to render
// them — this module never mutates either side.
export function checkRuntimeAgainstCatalog(runtimeView, catalog) {
  const out = [];
  if (!Array.isArray(runtimeView)) return out;
  for (const node of runtimeView) {
    const ws = checkNodeAgainstCatalog(node, catalog);
    for (const w of ws) out.push(w);
  }
  // Stable order: by severity (P0 first), then by provider/id.
  out.sort((a, b) => {
    const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
    const da = order[a.severity] ?? 9;
    const db = order[b.severity] ?? 9;
    if (da !== db) return da - db;
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
    return (a.node_id || '') < (b.node_id || '') ? -1 : 1;
  });
  return out;
}

// Helper for report writers: roll up warning counts by severity.
export function summarizeWarnings(warnings) {
  const out = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const w of warnings) {
    if (out[w.severity] !== undefined) out[w.severity] += 1;
  }
  return out;
}

// Aggregate protocol/surface capability counts across the Catalog. Used
// by the GitHub Action Summary. Returns
// { openai_chat_supported, openai_responses_supported, anthropic_messages_supported, providers_total }.
// `supported` here means the entry has supported=true. We do not count
// `null` (unknown) — that is the v1.1 guarantee.
export function aggregateCatalogCapabilities(catalog) {
  const out = {
    openai_chat_supported: 0,
    openai_responses_supported: 0,
    anthropic_messages_supported: 0,
    anthropic_count_tokens_supported: 0,
    providers_total: 0,
    providers_with_openai_supported: 0,
    providers_with_anthropic_supported: 0,
  };
  const providers = catalog?.providers || {};
  for (const [, p] of Object.entries(providers)) {
    out.providers_total += 1;
    const o = p?.openai;
    const a = p?.anthropic;
    if (o?.supported === SUPPORT_TRUE) {
      out.providers_with_openai_supported += 1;
      const set = new Set(o.surfaces || []);
      if (set.has('chat_completions')) out.openai_chat_supported += 1;
      if (set.has('responses')) out.openai_responses_supported += 1;
    }
    if (a?.supported === SUPPORT_TRUE) {
      out.providers_with_anthropic_supported += 1;
      const set = new Set(a.surfaces || []);
      if (set.has('messages')) out.anthropic_messages_supported += 1;
      if (set.has('count_tokens')) out.anthropic_count_tokens_supported += 1;
    }
  }
  return out;
}