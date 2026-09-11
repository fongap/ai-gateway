// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Logical-model family fallback.
//
// This is deliberately separate from protocol fallback. Protocol fallback
// changes the wire protocol/surface for the SAME logical model; model fallback
// changes only the logical model while preserving the client route, request,
// wall-clock budget, logical-attempt budget, and reliability machinery.
//
// The policy is intentionally closed and bounded:
//   Code-Max <-> Code-Pro, then Code-Ultra; Code-Ultra may fall back to
//   Code-Max/Code-Pro. Code models never cross into the non-Code family.
//   Max <-> Pro, then Ultra; Ultra may fall back to Max/Pro.
//   Air may move upward to Pro -> Max -> Ultra, but once it moves upward it
//   never returns to Air.
//   Interchangeable families get at most two evaluation rounds. The second
//   round exists only to re-check capacity that may have recovered while other
//   model pools were being tried. There is never an unbounded cycle.

const FALLBACK_ORDER: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'code-ultra': Object.freeze(['code-ultra', 'code-max', 'code-pro']),
  'code-max': Object.freeze(['code-max', 'code-pro', 'code-ultra']),
  'code-pro': Object.freeze(['code-pro', 'code-max', 'code-ultra']),
  ultra: Object.freeze(['ultra', 'max', 'pro']),
  max: Object.freeze(['max', 'pro', 'ultra']),
  pro: Object.freeze(['pro', 'max', 'ultra']),
  air: Object.freeze(['air', 'pro', 'max', 'ultra']),
});

function keyOf(model: string): string {
  return model.trim().toLowerCase();
}

function catalogByKey(knownModels: ReadonlySet<string>): Map<string, string> {
  const catalog = new Map<string, string>();
  for (const model of knownModels) {
    const key = keyOf(model);
    if (key && !catalog.has(key)) catalog.set(key, model);
  }
  return catalog;
}

/**
 * Return the ordered, bounded model-evaluation rounds for one client model.
 * Model spelling/casing comes from the known-model catalog so the scheduler
 * always receives a real logical alias. Unknown models keep legacy behavior:
 * one pass, no model fallback.
 */
export function buildModelFallbackRounds(
  requestedModel: string,
  knownModels: ReadonlySet<string>,
): string[][] {
  const requestedKey = keyOf(requestedModel);
  const template = FALLBACK_ORDER[requestedKey];
  if (!template) return [[requestedModel]];

  const catalog = catalogByKey(knownModels);
  const firstRound: string[] = [];
  for (const key of template) {
    const resolved = key === requestedKey ? requestedModel : catalog.get(key);
    if (resolved && !firstRound.includes(resolved)) firstRound.push(resolved);
  }

  if (firstRound.length <= 1) return [firstRound.length ? firstRound : [requestedModel]];

  // Air is one-way upward. A request that already moved to Pro/Max/Ultra must
  // not later fall back down to Air. Other family members are mutually
  // interchangeable and may therefore be re-evaluated once.
  const secondRound = requestedKey === 'air'
    ? firstRound.filter((model) => keyOf(model) !== 'air')
    : [...firstRound];

  return secondRound.length > 0 ? [firstRound, secondRound] : [firstRound];
}

/** Unique model candidates, preserving first-appearance order. */
export function modelFallbackCandidates(
  requestedModel: string,
  knownModels: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const round of buildModelFallbackRounds(requestedModel, knownModels)) {
    for (const model of round) {
      if (seen.has(model)) continue;
      seen.add(model);
      out.push(model);
    }
  }
  return out;
}
