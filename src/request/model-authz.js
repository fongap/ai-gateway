// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Model authorization. v1.2.7 governance model.
//
// Two complementary primitives:
//
//   filterVisibleModels(knownModels, authz)
//     Returns the subset of `knownModels` that the current key is allowed
//     to see. Used by /v1/models. Visible == Callable.
//
//   authorizeModel(requestedModel, knownModels, authz)
//     Returns { allowed: true } or { allowed: false, status: 403 }.
//     Called by the request handler BEFORE the scheduler. An unauthorized
//     request never reaches candidate selection, the upstream, or the
//     reliability layer.
//
// `knownModels` is the Known Model Catalog (collectKnownModels): the union
// of every explicit `node.models` key and every MODELS_CONFIG key. This is
// the single source of model existence for the whole request path.
//
// Fail-closed rules:
//   * An empty catalog grants ZERO models — even an allow-all key can never
//     call a model that exists nowhere in the gateway.
//   * authz.allowAll ("*" = legacy key or GATEWAY_ACCESS_MODELS_<GROUP>="*")
//     means "all models in the Known Model Catalog", NOT "any model string".
//   * A per-key allowlist is intersected with the catalog.
//
// `authz` is the auth result from authorize(). When authz.allowAll is true
// (legacy key or GATEWAY_ACCESS_MODELS_<GROUP>="*"), the entire catalog is
// visible/callable. Otherwise the key's allowlist is intersected with the
// catalog.

// Returns a sorted array of model names visible to the current key.
export function filterVisibleModels(knownModels, authz) {
  if (!knownModels || knownModels.size === 0) return [];
  if (!authz || !authz.authorized) return [];
  if (authz.allowAll) return [...knownModels].sort();
  if (!authz.allowlist || authz.allowlist.size === 0) return [];
  return [...knownModels].filter((m) => authz.allowlist.has(m)).sort();
}

// Returns { allowed: boolean, status?: 401 | 403 | 404 }.
// When allowed is false, `status` is 401/403/404 and the handler must return
// that response without entering the scheduler.
export function authorizeModel(requestedModel, knownModels, authz) {
  // No key -> handled by the auth layer (401). If we somehow get here
  // without auth, fail closed.
  if (!authz || !authz.authorized) return { allowed: false, status: 401 };
  // An empty Known Model Catalog grants ZERO models. Even an allow-all key
  // cannot conjure a model that exists nowhere in the gateway — a wildcard
  // node + empty catalog serves nothing.
  if (!knownModels || knownModels.size === 0) return { allowed: false, status: 404 };
  // Allow-all keys (legacy or GATEWAY_ACCESS_MODELS_<GROUP>="*") are bounded
  // by the catalog: "*" means every KNOWN model, never any model string.
  if (authz.allowAll) {
    return knownModels.has(requestedModel)
      ? { allowed: true }
      : { allowed: false, status: 404 };
  }
  // Per-key allowlist: the model must be in both the allowlist AND the
  // catalog. If it's in the allowlist but not the catalog, treat it as not
  // callable (404 — the model doesn't exist). If it's in the catalog but not
  // in the allowlist, treat it as 403.
  const inAllowlist = authz.allowlist ? authz.allowlist.has(requestedModel) : false;
  if (!inAllowlist) {
    // To avoid leaking whether an internal model exists, the handler
    // returns 403 for both "not in allowlist" and "model not in catalog
    // but key has no permission anyway". The 404 path is only reached for
    // an allow-all key, or a key whose allowlist does name the model but
    // the catalog does not contain it.
    return { allowed: false, status: 403 };
  }
  if (!knownModels.has(requestedModel)) {
    return { allowed: false, status: 404 };
  }
  return { allowed: true };
}