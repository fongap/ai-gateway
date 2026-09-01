// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Snapshot loading helpers for Provider Discovery.
//
// A "snapshot" is a persisted Provider Capability Catalog written to disk
// by an operator or a previous Discovery run. The loader normalizes the
// snapshot and returns a fresh object with stable shape. Secrets are
// NEVER loaded — the snapshot has no place to store them.

import fs from 'node:fs';
import { normalizeCatalog } from './normalize.js';
import { validateCatalog } from './catalog-schema.js';

export function loadSnapshotFromFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`failed to parse snapshot JSON at ${filePath}: ${e.message}`);
  }
  const validation = validateCatalog(parsed);
  const { catalog, warnings } = normalizeCatalog(parsed);
  return {
    catalog,
    validation,
    loadWarnings: warnings,
    source: filePath,
  };
}

// A "runtime view" is a minimal projection of Runtime Node configuration
// used only for consistency checks. We never read secrets: the loader
// expects the caller to pass an already-sanitized array.
//
// Allowed input fields per entry:
//   id (string, required)
//   provider (string, required)
//   protocol ("openai" | "anthropic", required)
//   surfaces (string[], optional)
//   base_url (string, optional)
//
// Extra fields are ignored.
export function loadRuntimeViewFromFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`failed to parse runtime view JSON at ${filePath}: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`runtime view at ${filePath} must be a JSON array`);
  }
  // Sanitize: project only allowed fields. Never include credential.
  const projected = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const out = {
      id: typeof raw.id === 'string' ? raw.id : '',
      provider: typeof raw.provider === 'string' ? raw.provider : '',
      protocol: typeof raw.protocol === 'string' ? raw.protocol : '',
      surfaces: Array.isArray(raw.surfaces) ? raw.surfaces.filter((s) => typeof s === 'string') : [],
    };
    if (typeof raw.base_url === 'string') out.base_url = raw.base_url;
    projected.push(out);
  }
  return projected;
}