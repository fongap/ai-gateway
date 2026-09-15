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
// `max_attempts` is always the request-wide hard ceiling. Family planning never
// increases it. Small budgets widen across siblings first; extra budget then
// deepens the requested model according to the established 3/2/1 preference.

import type { RuntimeNode } from '../types/node.ts';

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
const DEFAULT_FAMILY_ATTEMPT_BUDGET = 6;

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

function normalizedBudget(maxAttempts: number): number {
  if (!Number.isFinite(maxAttempts)) return DEFAULT_FAMILY_ATTEMPT_BUDGET;
  return Math.max(1, Math.trunc(maxAttempts));
}

function firstRoundPlan(
  requestedKey: string,
  template: readonly string[],
  round: readonly string[],
  maxAttempts: number,
): ModelFallbackPass[] {
  // A budget smaller than the family width must not silently expose more
  // sibling models than the operator allowed attempts for. Give one slot to
  // each model in preference order first, then deepen the preferred models.
  const visible = round.slice(0, Math.min(round.length, maxAttempts));
  const caps = visible.map(() => 1);
  let remaining = Math.max(0, maxAttempts - visible.length);
  const preferredCaps = requestedKey === 'air'
    ? AIR_FIRST_ROUND_CAPS
    : THREE_MEMBER_FIRST_ROUND_CAPS;

  for (let i = 0; i < visible.length && remaining > 0; i++) {
    const templateIndex = template.indexOf(keyOf(visible[i]));
    const target = templateIndex >= 0 ? (preferredCaps[templateIndex] ?? 1) : 1;
    const extra = Math.min(remaining, Math.max(0, target - caps[i]));
    caps[i] += extra;
    remaining -= extra;
  }

  return visible.map((model, i) => ({ model, attemptCap: caps[i] }));
}

/**
 * Return model passes with per-pass attempt caps.
 *
 * `attemptCap=null` means legacy behavior for an unknown/non-family model: the
 * request policy owns the whole attempt budget. Family members never enlarge
 * that budget. For a three-member family the first-round allocation evolves as
 * 1 -> 1/1 -> 1/1/1 -> 2/1/1 -> 3/1/1 -> 3/2/1. Any budget beyond the first
 * round can be used by the existing bounded re-check round.
 */
export function buildModelFallbackPlan(
  requestedModel: string,
  knownModels: ReadonlySet<string>,
  maxAttempts: number = DEFAULT_FAMILY_ATTEMPT_BUDGET,
): ModelFallbackPass[][] {
  const requestedKey = keyOf(requestedModel);
  const template = FALLBACK_ORDER[requestedKey];
  const rounds = buildModelFallbackRounds(requestedModel, knownModels);
  if (!template) return rounds.map((round) => round.map((model) => ({ model, attemptCap: null })));

  const budget = normalizedBudget(maxAttempts);
  const first = firstRoundPlan(requestedKey, template, rounds[0], budget);
  const allowed = new Set(first.map((pass) => pass.model));
  const out: ModelFallbackPass[][] = [first];

  // Re-check only models that fit inside this policy's family width. The global
  // request counter remains authoritative, so this round can consume only
  // budget left unused by earlier passes.
  if (rounds[1]?.length) {
    const second = rounds[1]
      .filter((model) => allowed.has(model))
      .map((model) => ({ model, attemptCap: 1 }));
    if (second.length) out.push(second);
  }
  return out;
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

/**
 * Request-local failure-domain identity for logical-model fallback.
 *
 * One RuntimeNode is one configured upstream account/key-slot identity. If two
 * logical aliases on that same node resolve to the same upstream model, they
 * are the same real failure domain and must not consume separate retry budget
 * after one of them has already failed in this request. Protocol/base URL are
 * node properties, and surface changes do not create fresh account/model
 * capacity, so neither belongs in the key.
 *
 * Raw credentials are deliberately excluded. The gateway never hashes,
 * compares, logs or persists secret material merely to deduplicate retries.
 */
export function modelFailureDomainKey(node: RuntimeNode, logicalModel: string): string {
  const upstreamModel = node.models[logicalModel] || logicalModel;
  return JSON.stringify([node.id, upstreamModel]);
}

/**
 * Seed a new logical-model pass with nodes whose real account/model domain has
 * already failed earlier in this request. A node mapped to a DIFFERENT real
 * upstream model stays eligible, even when it is the same configured account.
 * A different node/account mapped to the same model also stays eligible.
 */
export function failedDomainNodeIds(
  nodes: ReadonlyArray<RuntimeNode>,
  logicalModel: string,
  failedDomains: ReadonlySet<string>,
): Set<string> {
  const attempted = new Set<string>();
  if (failedDomains.size === 0) return attempted;
  for (const node of nodes) {
    if (failedDomains.has(modelFailureDomainKey(node, logicalModel))) {
      attempted.add(node.id);
    }
  }
  return attempted;
}

/** Record the actual node/model domains touched by one failed logical pass. */
export function rememberFailedDomains(
  failedDomains: Set<string>,
  nodesById: ReadonlyMap<string, RuntimeNode>,
  attemptedNodeIds: ReadonlySet<string>,
  logicalModel: string,
): void {
  for (const nodeId of attemptedNodeIds) {
    const node = nodesById.get(nodeId);
    if (node) failedDomains.add(modelFailureDomainKey(node, logicalModel));
  }
}
