// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Model authorization. v1.2.7 governance model.
//
// Two complementary primitives:
//
//   filterVisibleModels(configuredModels, authz)
//     Returns the subset of `configuredModels` that the current key is
//     allowed to see. Used by /v1/models. Visible == Callable.
//
//   authorizeModel(requestedModel, configuredModels, authz)
//     Returns { allowed: true } or { allowed: false, status: 403 }.
//     Called by the request handler BEFORE the scheduler. An unauthorized
//     request never reaches candidate selection, the upstream, or the
//     reliability layer.
//
// `configuredModels` is the union of all `node.models` keys from
// TIER{1,2,3}_NODES_CONFIG_* (the single source of model existence).
//
// `authz` is the auth result from authorize(). When authz.allowAll is
// true (legacy key or GATEWAY_ACCESS_MODELS_<GROUP>="*"), the entire
// configured set is visible/callable. Otherwise the key's allowlist is
// intersected with the configured set.

// Returns a sorted array of model names visible to the current key.
export function filterVisibleModels(configuredModels, authz) {
  if (!configuredModels || configuredModels.size === 0) return [];
  if (!authz || !authz.authorized) return [];
  if (authz.allowAll) return [...configuredModels].sort();
  if (!authz.allowlist || authz.allowlist.size === 0) return [];
  return [...configuredModels].filter((m) => authz.allowlist.has(m)).sort();
}

// Returns { allowed: boolean, status?: 403 }.
// When allowed is false, `status` is 403 and the handler must return that
// response without entering the scheduler.
export function authorizeModel(requestedModel, configuredModels, authz) {
  // No key -> handled by the auth layer (401). If we somehow get here
  // without auth, fail closed.
  if (!authz || !authz.authorized) return { allowed: false, status: 401 };
  // Allow-all keys (legacy or GATEWAY_ACCESS_MODELS_<GROUP>="*") are still
  // bounded by the configured set: a model not in any node's `models` map
  // is not callable even with a wildcard key.
  if (authz.allowAll) {
    if (configuredModels && configuredModels.size > 0 && !configuredModels.has(requestedModel)) {
      return { allowed: false, status: 404 };
    }
    return { allowed: true };
  }
  // Per-key allowlist: the model must be in both the allowlist AND the
  // configured set. If it's in the allowlist but not configured, treat it
  // as not callable (404 — the model doesn't exist). If it's configured
  // but not in the allowlist, treat it as 403.
  const inAllowlist = authz.allowlist ? authz.allowlist.has(requestedModel) : false;
  if (!inAllowlist) {
    // To avoid leaking whether an internal model exists, the handler
    // returns 403 for both "not in allowlist" and "model not configured
    // but key has no permission anyway". The scheduler 404 path is only
    // reached when the key is allowAll (see above).
    return { allowed: false, status: 403 };
  }
  if (configuredModels && configuredModels.size > 0 && !configuredModels.has(requestedModel)) {
    return { allowed: false, status: 404 };
  }
  return { allowed: true };
}
