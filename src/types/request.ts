// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Request orchestration types. Canonical source for the request pipeline,
// consumed by the scheduler and request layers. Shapes mirror what the
// request layer actually passes through handleRequest → runTierLoop →
// dispatchWithHedge → attemptNode (src/types/domain.d.ts has been deleted —
// see docs/governance/typescript-migration.md).

import type { Protocol, Surface } from './protocol.ts';
import type { RuntimeNode } from './node.ts';
import type { PolicyConfig } from './policy.ts';
import type { Tier, RoutableRequest } from './scheduler.ts';
import type { FailureKind } from '../reliability/classify.ts';

/** The (protocol, surface, route) triple identifying one client-facing route. */
export type RequestDescriptor = {
  route: 'openai_chat' | 'openai_responses' | 'anthropic_messages' | 'anthropic_count_tokens',
  model: string,
  protocol: Protocol,
  surface: Surface,
};

/**
 * Auth result from authorize(). `mode` is 'grouped' (new system), 'legacy'
 * (GATEWAY_ACCESS_KEY), 'none', or 'skip' (version route short-circuit).
 * `group` is the credential group label ('AIR', 'PRO', 'MAX', 'ULTRA',
 * 'AGENT', 'LEGACY') — the only non-secret identifier used in logs.
 */
export type AuthResult =
  | { authorized: false, mode: 'none' | 'grouped' | 'legacy' }
  | { authorized: true, mode: 'legacy' | 'grouped', group: string, allowAll: boolean, allowlist: Set<string> | undefined }
  | { authorized: true, mode: 'skip', group: null };

/**
 * Result of evaluateRouteFeasibility — the pre-orchestration check that
 * decides whether a request has ANY reachable execution path. Computed
 * once in preflight and carried through the pipeline via LoopContext.
 *
 *   reachable        = nativeSupported || fallbackSupported
 *   nativeSupported  = at least one node matches the client's protocol+surface+model
 *   fallbackSupported = at least one configured fallback has a candidate
 *   fallbacks        = the list of reachable fallback targets (protocol+surface)
 */
export type RouteFeasibilityResult = {
  reachable: boolean,
  nativeSupported: boolean,
  fallbackSupported: boolean,
  fallbacks: ReadonlyArray<{ protocol: Protocol, surface: Surface }>,
};

/** Cross-protocol conversion context for one fallback pass (built in
 * fallback.ts; null on the native pass). */
export type ConversionContext = {
  fallbackProtocol: Protocol,
  fallbackSurface: Surface,
  /** Client-controlled parsed JSON body — its shape is validated at use sites. */
  convertedBody: Record<string, unknown>,
  clientRoute: string,
};

/**
 * The shared request-level state object built in handleRequest and threaded
 * through runTierLoop and attempt.ts. Carries the three separate counters
 * (logicalAttempts, dispatches, hedges), the attempted set, the failure-kind
 * histogram, and aliases for logging / config.
 */
export type LoopState = {
  attempted: Set<string>,
  attempts: Array<Record<string, unknown>>,
  logicalAttempts: number,
  dispatches: number,
  hedges: number,
  // R3 (v1.3.0): the failure-kind histogram is now typed by FailureKind so
  // the compiler rejects any new kind string that has not been declared in
  // src/reliability/classify.ts. Partial because kinds are accumulated
  // incrementally — an empty `{}` is a valid initial state.
  failureKinds: Partial<Record<FailureKind, number>>,
  logger: { info: Function, debug: Function, error: Function },
  requestId: string,
  maxAttempts: number,
  maxDispatches: number,
  requestedModel: string,
  nodes: ReadonlyArray<RuntimeNode>,
  /** Legacy alias carried by some call sites; preflight computes it once. */
  knownModels?: ReadonlySet<string>,
  tier1ExhaustionReason?: string,
};

/**
 * The context object carried through the native and fallback tier loops.
 * Built once in handleRequest and passed to runTierLoop, which then threads
 * it into attempt.ts via dispatchWithHedge args.
 */
export type LoopContext = {
  request: Request,
  env: Record<string, unknown>,
  ctx: { waitUntil?: Function },
  logger: { info: Function, debug: Function, error: Function },
  requestId: string,
  route: string,
  requestedModel: string,
  clientWantsStream: boolean,
  fakeStream: boolean,
  /** Client-controlled parsed JSON body — its shape is validated at use sites. */
  bodyJson: Record<string, unknown>,
  limits: Record<string, number>,
  exposeUpstreamInfo: boolean,
  state: LoopState,
  failoverBudgetMs: number,
  requestStartMs: number,
  policy: PolicyConfig,
  tiers: Record<number, RuntimeNode[]>,
  tier1Affinity: string | null,
  tier1EvaluateAffinity: boolean,
  tier1Rng: () => number,
  tier1Session: string | null,
  knownModels: Set<string>,
  feasibility: RouteFeasibilityResult,
};

/**
 * Dispatch context for a single attempt. Passed by the tier loop to
 * attempt.ts via dispatchWithHedge. Carries everything one upstream
 * dispatch needs: the chosen node, the request descriptor, budget
 * state, hedge handles, and conversion context.
 */
export type AttemptContext = {
  request: Request,
  env: Record<string, unknown>,
  ctx: { waitUntil?: Function },
  logger: { info: Function, debug: Function, error: Function },
  requestId: string,
  route: string,
  node: RuntimeNode,
  requestedModel: string,
  clientWantsStream: boolean,
  fakeStream: boolean,
  /** Client-controlled parsed JSON body — its shape is validated at use sites. */
  bodyJson: Record<string, unknown>,
  limits: Record<string, number>,
  exposeUpstreamInfo: boolean,
  state: LoopState,
  failoverBudgetMs: number,
  requestStartMs: number,
  remainingDispatchableAttempts: number,
  /** The active (protocol, surface, model) triple — the fallback passes carry
   * the fallback descriptor without a client route. */
  reqDescriptor: RoutableRequest,
  policy: PolicyConfig,
  tierNumber: Tier,
  conversionContext: ConversionContext | null,
  tier1ReleaseToken: { accountId: string, released: boolean } | null,
  tier1EscapedFromAffinity: boolean,
  tier1UpdateAffinity: boolean,
  tier1AffinityAccountId: string | null,
  tier1EvaluateAffinity: boolean,
  tier1Session: string | null,
  rng: (() => number) | null,
  // Fields below are assigned by dispatchWithHedge / dispatchAttempt, not by
  // the tier loop — they are optional on the caller-facing context.
  hedgedAttempt?: boolean,
  hedgedWithTwin?: boolean,
  hedgeAbort?: { signal: { aborted: boolean, addEventListener: Function }, abort: Function } | null,
  attemptDeadlineMs?: number,
  attemptStartMs?: number,
  headersMs?: number,
  ttftMs?: number,
  upstreamProtocol?: Protocol,
  surface?: Surface,
};

/**
 * Outcome returned by attemptNode / dispatchWithHedge.
 * Exactly one of: committed response, rotate, or stop.
 */
export type AttemptOutcome = {
  response?: Response,
  rotate?: boolean,
  stop?: boolean,
  budgetCharged?: boolean,
  // R3 (v1.3.0): kind is typed as FailureKind (the full taxonomy) so the
  // compiler catches any drift between the classifier in
  // src/reliability/classify.ts and the consumers in attempt/*.ts. The
  // previous `string` type allowed any literal to leak through.
  kind?: FailureKind,
  hedgedAway?: boolean,
};
