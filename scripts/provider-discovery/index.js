// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Public re-exports for the Provider Discovery module. Tests and CLI
// drivers should import from `./provider-discovery/index.js` rather than
// reaching into the individual files; this keeps the surface narrow.

export {
  PROTOCOLS,
  SURFACES_BY_PROTOCOL,
  EVIDENCE_LEVELS,
  RUNTIME_NODE_SURFACES,
  SUPPORT_TRUE,
  SUPPORT_FALSE,
  SUPPORT_NULL,
  CATALOG_SCHEMA_VERSION,
  CAPABILITY_ENTRY_FIELDS,
  isProtocol,
  isSurfaceFor,
  isEvidence,
  isSupportTriState,
  validateCapabilityEntry,
  validateCatalog,
  loadCatalogFile,
} from './catalog-schema.js';

export {
  normalizeCatalog,
  normalizeProvider,
  normalizeCapabilityEntry,
  normalizeRuntimeView,
  canonicalizeBaseUrl,
} from './normalize.js';

export {
  diffCatalogs,
  summarizeBySeverity,
  hasProtocolDowngrade,
} from './diff.js';

export {
  checkRuntimeAgainstCatalog,
  summarizeWarnings,
  aggregateCatalogCapabilities,
} from './runtime-check.js';

export {
  formatChangesMarkdown,
  formatActionSummary,
  formatJsonReport,
} from './report.js';

export {
  loadSnapshotFromFile,
  loadRuntimeViewFromFile,
} from './load-snapshot.js';