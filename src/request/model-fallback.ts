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
//
// First-round family budgets prevent the requested alias from consuming the
// entire request budget before compatible pools get a chance. Three-member
// families use 3 -> 2 -> 1. Air uses 3 -> 1 -> 1 -> 1 so the whole one-way
// chain still fits a six-attempt family budget. A second-round re-check is
// limited to one attempt per model and only uses budget left unused by round 1.

const FALLBACK_ORDER: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'code-ultra': Object.freeze(['code-ultra', 'code-max', 'code-pro']),
  'code-max': Object.freeze(['code-max', 'code-pro', 'code-ultra']),
  'code-pro': Object.freeze(['code-pro', 'code-max', 'code-ultra']),
  ultra: Object.freeze(['ultra', 'max', 'pro']),
  max: Object.freeze(['max', 'pro', 'ultra']),
  pro: Object.freeze(['pro', 'max', 'ultra']),
  air: Object.freeze(['air', 'pro', 'max', 'ultra']),
});

const THREE_MEMBER_FIRST_ROUND_CAPS = Object.freeze([3, 2, 1]);
const AIR_FIRST_ROUND_CAPS = Object.freeze([3, 1, 1, 1]);

export type ModelFallbackPass = {
  model: string,
  attemptCap: number | null,
};

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

/**
 * Return model passes with per-pass attempt caps.
 *
 * `attemptCap=null` means legacy behavior for an unknown/non-family model: the
 * request policy owns the whole attempt budget. Family members reserve the
 * first round as 3/2/1 (or Air 3/1/1/1); a second-round re-check is one attempt
 * per model and can only spend request budget that round 1 did not consume.
 */
export function buildModelFallbackPlan(
  requestedModel: string,
  knownModels: ReadonlySet<string>,
): ModelFallbackPass[][] {
  const requestedKey = keyOf(requestedModel);
  const template = FALLBACK_ORDER[requestedKey];
  const rounds = buildModelFallbackRounds(requestedModel, knownModels);
  if (!template) return rounds.map((round) => round.map((model) => ({ model, attemptCap: null })));

  const firstCaps = requestedKey === 'air' ? AIR_FIRST_ROUND_CAPS : THREE_MEMBER_FIRST_ROUND_CAPS;
  return rounds.map((round, roundIndex) => round.map((model) => {
    if (roundIndex > 0) return { model, attemptCap: 1 };
    const templateIndex = template.indexOf(keyOf(model));
    return {
      model,
      attemptCap: templateIndex >= 0 ? (firstCaps[templateIndex] ?? 1) : 1,
    };
  }));
}

/** True when the requested model belongs to a configured fallback family. */
export function hasModelFamilyFallback(requestedModel: string): boolean {
  return Boolean(FALLBACK_ORDER[keyOf(requestedModel)]);
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
