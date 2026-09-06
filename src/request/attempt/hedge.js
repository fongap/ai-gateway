// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
// Part of src/request/attempt.js (behavior-preserving split); see
// attempt/index.js for the module map.

// hedge.js - reactive per-try hedge (Envoy-style): the hedge delay race,
// twin selection through the same protocol/surface-gated selector as the
// primary, the shared logical-attempt deadline, and the winner/loser
// lifecycle including abort of the losing side.

import { pickCandidate } from '../../scheduler/scheduler.js';
import { pickTier1Candidate } from '../../scheduler/tier1-scheduler.js';
import { attemptNode } from './dispatch.js';

/** @param {number} ms */
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Hedged dispatch (reactive per-try hedge, Envoy-style) -----------------
// A slow-but-alive node is the dominant tail-latency source: the scheduler
// cannot know a candidate will be slow, and once an attempt is awaiting its
// first event the sequential loop simply waits for it. If the first attempt
// has not committed a response within HEDGE_DELAY_MS, launch ONE twin attempt
// against the next-best candidate and let the two race. The first committed
// response wins; the twin is aborted and recorded as a NEUTRAL end (it was
// slow, not broken).
//
// Hedge vs. logical attempt: the twin is an EXTRA executioner of the SAME
// logical attempt, not an attempt of its own. It charges neither the
// max_attempts budget nor the tier cap; it is bounded instead by
// MAX_HEDGES_PER_REQUEST (default 1) and by the hard dispatch ceiling
// maxDispatches = maxAttempts + maxHedgesPerRequest. Both executioners share
// the logical attempt's wall-clock slice: the twin INHERITS the primary's
// absolute attempt deadline instead of being handed a fresh one. See The Tail
// at Scale (Dean & Barroso, 2013) for the underlying technique and its
// overload caveat.
/**
 * @param {AttemptContext} args
 * @param {ReadonlyArray<RuntimeNode>} tierNodes
 * @returns {Promise<AttemptOutcome>}
 */
export async function dispatchWithHedge(args, tierNodes) {
  // Resolve effective hedge config: policy.hedge (per-model) overrides
  // the global env defaults. Tier 3 (paid) nodes NEVER hedge by default
  // — two paid requests in parallel is rarely worth the cost. To hedge
  // a paid tier, opt in via policy.hedge.tiers=['tier3'] or policy: 'stable'.
  const hedgePolicy = args.policy?.hedge ?? null;
  /** @type {'tier1' | 'tier2' | 'tier3'} */
  const tierKey = `tier${args.tierNumber}`;
  if (args.tierNumber === 3 && !(hedgePolicy && hedgePolicy.tiers && hedgePolicy.tiers.includes('tier3') && hedgePolicy.enabled !== false)) {
    return attemptNode(args);
  }
  let hedgeDelayMs, maxHedges;
  if (hedgePolicy) {
    if (hedgePolicy.enabled === false) return attemptNode(args);
    if (hedgePolicy.tiers && !hedgePolicy.tiers.includes(tierKey)) return attemptNode(args);
    hedgeDelayMs = hedgePolicy.delayMs ?? args.limits.hedgeDelayMs;
    maxHedges = args.limits.maxHedgesPerRequest ?? 1;
  } else {
    hedgeDelayMs = args.limits.hedgeDelayMs || 0;
    maxHedges = args.limits.maxHedgesPerRequest ?? 1;
  }
  if (hedgeDelayMs <= 0 || maxHedges <= 0) return attemptNode(args);

  // The primary holds its own args object so the twin can inherit the logical
  // attempt deadline it computes, and so its ttft measurement can feed the
  // winner log even when it wins after the twin was already launched.
  const primaryArgs = { ...args, hedgeAbort: new AbortController() };
  const primary = attemptNode(primaryArgs);
  const verdict = await Promise.race([
    primary.then(() => 'settled', () => 'settled'),
    sleepMs(hedgeDelayMs).then(() => 'hedge'),
  ]);
  if (verdict === 'settled') return primary;

  // Hedge gates: hard caps ONLY — never the logical-attempt budget or the tier
  // cap, which the twin deliberately does not consume. The in-flight primary
  // has not charged its dispatch yet, so the eventual dispatch count is
  // dispatches + 2 (primary charge + twin); the ceiling bounds the whole
  // request to maxAttempts + maxHedgesPerRequest upstream calls.
  if (args.state.hedges >= maxHedges) return primary;
  if (args.state.dispatches + 2 > args.state.maxDispatches) return primary;
  // Shared deadline FIRST, BEFORE any candidate is picked or claimed. The
  // selector below claims a concurrency slot + RPM reservation as a side
  // effect of picking (acquireSlot inside pickCandidate), so a deadline that
  // is already exhausted must bail out here — returning after the pick would
  // strand those reservations on a twin that is never dispatched (the node
  // then looks saturated, worst case at limits.concurrency=1). No remaining
  // time means no fresh budget can be conjured here; an undefined deadline
  // (primary still awaiting its rate-limiter check) is treated the same way.
  const deadlineRemainingMs = (primaryArgs.attemptDeadlineMs ?? 0) - Date.now();
  if (deadlineRemainingMs <= 0) return primary;
  // The twin is picked through the same protocol/surface/model-gated selector
  // as the primary, so a hedge twin is ALWAYS same-protocol and same-surface
  // as its primary — an anthropic node can never twin an openai request, and
  // a chat-only node can never twin a /v1/responses attempt. The pick claims
  // the twin's slot atomically (re-checked inside acquireSlot), and the
  // deadline gate above guarantees the claim is always followed by a real
  // dispatch or a legitimate loser lifecycle.
  const legacyTwin = args.tierNumber === 1
    ? null : pickCandidate(tierNodes, args.reqDescriptor, args.state.attempted, Date.now(), args.node.id);
  /** @type {PickedCandidate | null} */
  const twinPick = args.tierNumber === 1
    ? pickTier1Candidate(tierNodes, args.reqDescriptor, args.state.attempted, {
      excludeId: args.node.id,
      now: Date.now(),
      rng: args.rng ?? Math.random,
      affinityAccountId: args.tier1AffinityAccountId,
      evaluateAffinity: args.tier1EvaluateAffinity,
    })
    : legacyTwin ? { node: legacyTwin, raceLost: false } : null;
  if (!twinPick || twinPick.raceLost) return primary;
  // The raceLost guard above is exactly the "no node picked" case, so node is
  // defined here by the picker's contract.
  const twinNode = /** @type {RuntimeNode} */ (twinPick.node);

  args.state.hedges++;
  primaryArgs.hedgedWithTwin = true;
  const logicalAttemptNo = args.state.logicalAttempts + 1;
  args.logger.info(
    `hedge: request=${args.requestId} logical_attempt=${logicalAttemptNo}/${args.state.maxAttempts}`
    + ` primary=${args.node.id} twin=${twinNode.id} delay_ms=${hedgeDelayMs}`
    + ` deadline_remaining_ms=${deadlineRemainingMs}`,
  );

  // Both sides get an external abort handle up front so the loser can be
  // cancelled no matter which one wins the race.
  const twinArgs = {
    ...args, node: twinNode, hedgeAbort: new AbortController(), hedgedAttempt: true,
    // THE shared logical attempt deadline (absolute; not re-sliced).
    attemptDeadlineMs: /** @type {number} */ (primaryArgs.attemptDeadlineMs),
    tier1ReleaseToken: twinPick.releaseToken || null,
    tier1EscapedFromAffinity: !!twinPick.escapedFromAffinity,
    tier1UpdateAffinity: !!twinPick.updateAffinity,
  };
  const twin = attemptNode(twinArgs).then(undefined, (error) => {
    args.logger.debug(`hedge: twin ${twinNode.id} error ${error?.message || error}`);
    return { rotate: true, kind: 'unknown' };
  });
  const safePrimary = primary.then(undefined, (error) => {
    args.logger.debug(`hedge: primary ${args.node.id} error ${error?.message || error}`);
    return { rotate: true, kind: 'unknown' };
  });

  return new Promise((resolve) => {
    let resolved = false;
    let settled = 0;
    /** @type {AttemptOutcome | null} */
    let firstFailure = null;
    /** @type {AttemptOutcome | null} */
    let primaryOutcome = null;
    /** @type {AttemptOutcome | null} */
    let twinOutcome = null;
    /** @param {AttemptOutcome} outcome @param {AttemptContext} winnerArgs @param {{ abort: Function } | null} loserAbort */
  const win = (outcome, winnerArgs, loserAbort) => {
      if (resolved) {
        // Lost after the winner was chosen: drop any committed stream so no
        // upstream keeps streaming into the void.
        try { outcome.response?.body?.cancel(); } catch { /* already closed */ }
        return;
      }
      resolved = true;
      loserAbort?.abort();
      args.logger.info(
        `hedge winner: request=${args.requestId} logical_attempt=${logicalAttemptNo}/${args.state.maxAttempts}`
        + ` winner=${/** @type {RuntimeNode} */ (winnerArgs.node).id} loser=${(winnerArgs === primaryArgs ? twinNode : args.node).id}`
        + ` winner_ttft_ms=${winnerArgs.ttftMs ?? -1}`,
      );
      resolve(outcome);
    };
    /** @param {AttemptOutcome} outcome @param {boolean} isPrimary @param {{ abort: Function } | null} loserAbort */
    const onSettled = (outcome, isPrimary, loserAbort) => {
      settled++;
      if (isPrimary) primaryOutcome = outcome; else twinOutcome = outcome;
      if (outcome.response) win(outcome, isPrimary ? primaryArgs : twinArgs, loserAbort);
      else {
        if (!firstFailure || isPrimary) firstFailure = outcome;
        // Only report a failed hedge when BOTH sides failed. If one side
        // already won (resolved), the loser's late neutral outcome arrives
        // here too — logging then would print a misleading "hedge failed"
        // line with kind=unknown for the successful winner.
        if (settled >= 2 && !resolved) {
          args.logger.info(
            `hedge failed: request=${args.requestId} logical_attempt=${logicalAttemptNo}/${args.state.maxAttempts}`
            + ` primary=${args.node.id} twin=${twinNode.id}`
            + ` primary_kind=${primaryOutcome?.kind || 'unknown'} twin_kind=${twinOutcome?.kind || 'unknown'}`,
          );
          resolve({ ...firstFailure });
        }
      }
    };
    safePrimary.then((o) => onSettled(o, true, twinArgs.hedgeAbort));
    twin.then((o) => onSettled(o, false, primaryArgs.hedgeAbort));
  });
}
