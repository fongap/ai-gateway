// Domain types for the request hot path (config / scheduler / reliability / request).
//
// These JSDoc typedefs are the single source of truth for cross-module objects
// passed through the request orchestration layer. They are consumed by
// checkJs (via the package-level tsconfig.json) and by PR3+ refactors.
//
// Style rules:
//   - Prefer Readonly<> over mutable shapes for cross-module data.
//   - Union types over enums for fixed string sets (lighter weight, runtime-free).
//   - JSDoc only — no runtime exports, no value-side imports.

/**
 * @typedef {'openai' | 'anthropic'} Protocol
 */

/**
 * @typedef {'chat_completions' | 'responses' | 'messages'} Surface
 *
 *   chat_completions  -> openai /v1/chat/completions
 *   responses         -> openai /v1/responses
 *   messages          -> anthropic /v1/messages
 */

/**
 * @typedef {1 | 2 | 3} Tier
 */

/**
 * @typedef {`${Protocol}:${Surface}`} ProtocolSurface
 */

/**
 * @typedef {'unconfigured' | 'invalid' | 'degraded' | 'ready'} ConfigStatus
 */

/**
 * @typedef {{ [logicalModel: string]: string }} NodeModelMap
 *
 *   empty object {} means "wildcard" (node serves any model)
 *   non-empty maps the gateway's logical model to the upstream's model name
 */

/**
 * @typedef {{
 *   concurrency?: number,
 *   rpm?: number,
 *   rpmMode?: 'soft' | 'hard',
 * }} NodeLimits
 */

/**
 * @typedef {{
 *   id: string,
 *   tier: Tier,
 *   provider: string,
 *   protocol: Protocol,
 *   surfaces: ReadonlyArray<Surface>,
 *   baseUrl: string,
 *   credential: string,
 *   priority: number,
 *   models: NodeModelMap,
 *   limits: {
 *     concurrency: number,
 *     rpm?: number,
 *     rpmMode?: 'soft' | 'hard',
 *   },
 * }} RuntimeNode
 */

/**
 * @typedef {{
 *   stream: boolean,
 *   reasoning: boolean,
 *   vision: boolean,
 *   ocr: boolean,
 *   tools: boolean,
 * }} ModelCapabilities
 */

/**
 * @typedef {{
 *   policy: string,
 *   visibility: 'public' | 'internal',
 *   uiVisible: boolean,
 *   displayOrder: number,
 *   group: 'general' | 'code' | 'omni' | 'ocr',
 *   capabilities: ModelCapabilities,
 *   reasoningEfforts: ReadonlyArray<string>,
 * }} ModelRegistryEntry
 */

/**
 * @typedef {{
 *   [logicalModel: string]: ModelRegistryEntry,
 * }} ModelRegistry
 */

/**
 * @typedef {{
 *   maxAttempts: number,
 *   tierAttempts?: { tier1?: number, tier2?: number, tier3?: number },
 *   hedge?: { enabled: boolean, delayMs: number, tiers: ReadonlyArray<Tier> } | null,
 * }} PolicyConfig
 */

/**
 * @typedef {'public' | 'internal'} Visibility
 */

/**
 * @typedef {'AIR' | 'PRO' | 'MAX' | 'ULTRA' | 'AGENT' | 'LEGACY'} AccessKeyGroup
 */

/**
 * @typedef {{
 *   authorized: boolean,
 *   mode: 'skip' | 'legacy' | 'grouped',
 *   group: AccessKeyGroup | null,
 *   allowAll: boolean,
 *   allowlist: ReadonlyArray<string>,
 * }} AuthResult
 */

/**
 * @typedef {{
 *   route: 'openai_chat' | 'openai_responses' | 'anthropic_messages' | 'anthropic_count_tokens',
 *   protocol: Protocol,
 *   surface: Surface,
 * }} RequestDescriptor
 */

/**
 * Minimal routable request shape consumed by the scheduler's static
 * eligibility checks (supportsRequest and the Tier 1 equivalents). The tier
 * loop passes the RequestDescriptor of the current route plus the canonical
 * requested model — this is NOT the DOM Request.
 *
 * Declared as a real type (not @typedef) so it is ambient-global and
 * consumable from other files' JSDoc annotations.
 */
type RoutableRequest = {
  model: string,
  protocol: Protocol,
  surface: Surface,
};

/**
 * @typedef {{
 *   id: string,
 *   route: string,
 *   model: string,
 *   protocol: Protocol,
 *   surface: Surface,
 *   isStream: boolean,
 *   startedAtMs: number,
 *   authResult: AuthResult,
 *   sessionId: string | null,
 * }} RequestContext
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   status: number,
 *   errorMessage?: string,
 *   requestDescriptor?: RequestDescriptor,
 *   bodyJson?: unknown,
 *   requestedModel?: string,
 *   isStream?: boolean,
 * }} PreflightResult
 */

/**
 * @typedef {{
 *   logicalAttempt: number,
 *   dispatch: number,
 *   hedge: number,
 *   startedAtMs: number,
 *   deadlineRemainingMs: number,
 * }} AttemptBudget
 */

/**
 * Result of evaluateRouteFeasibility — the pre-orchestration check that
 * decides whether a request has ANY reachable execution path. Computed
 * once in preflight and carried through the pipeline via LoopContext.
 *
 *   reachable       = nativeSupported || fallbackSupported
 *   nativeSupported  = at least one node matches the client's protocol+surface+model
 *   fallbackSupported = at least one configured fallback has a candidate
 *   fallbacks        = the list of reachable fallback targets (protocol+surface)
 *
 * @typedef {{
 *   reachable: boolean,
 *   nativeSupported: boolean,
 *   fallbackSupported: boolean,
 *   fallbacks: ReadonlyArray<{ protocol: Protocol, surface: Surface }>,
 * }} RouteFeasibilityResult
 */

/**
 * The shared request-level state object built in handleRequest and threaded
 * through runTierLoop and attempt.js. Carries the three separate counters
 * (logicalAttempts, dispatches, hedges), the attempted set, the failure-kind
 * histogram, and aliases for logging / config.
 *
 * @typedef {{
 *   attempted: Set<string>,
 *   attempts: Array<Record<string, unknown>>,
 *   logicalAttempts: number,
 *   dispatches: number,
 *   hedges: number,
 *   failureKinds: Record<string, number>,
 *   logger: { info: Function, debug: Function, error: Function },
 *   requestId: string,
 *   maxAttempts: number,
 *   maxDispatches: number,
 *   requestedModel: string,
 *   nodes: ReadonlyArray<RuntimeNode>,
 *   tier1ExhaustionReason?: string,
 * }} LoopState
 */

/**
 * The context object carried through the native and fallback tier loops.
 * Built once in handleRequest and passed to runTierLoop, which then threads
 * it into attempt.js via dispatchWithHedge args.
 *
 * @typedef {{
 *   request: Request,
 *   env: Record<string, any>,
 *   ctx: { waitUntil?: Function },
 *   logger: { info: Function, debug: Function, error: Function },
 *   requestId: string,
 *   route: string,
 *   requestedModel: string,
 *   clientWantsStream: boolean,
 *   fakeStream: boolean,
 *   bodyJson: unknown,
 *   limits: Record<string, number>,
 *   exposeUpstreamInfo: boolean,
 *   state: LoopState,
 *   failoverBudgetMs: number,
 *   requestStartMs: number,
 *   policy: PolicyConfig,
 *   tiers: { 1: RuntimeNode[], 2: RuntimeNode[], 3: RuntimeNode[] },
 *   tier1Affinity: string | null,
 *   tier1EvaluateAffinity: boolean,
 *   tier1Rng: () => number,
 *   tier1Session: string | null,
 *   knownModels: Set<string>,
 *   feasibility: RouteFeasibilityResult,
 * }} LoopContext
 */

/**
 * Dispatch context for a single attempt. Passed by the tier loop to
 * attempt.js via dispatchWithHedge. Carries everything one upstream
 * dispatch needs: the chosen node, the request descriptor, budget
 * state, hedge handles, and conversion context.
 *
 * @typedef {{
 *   request: Request,
 *   env: Record<string, any>,
 *   ctx: { waitUntil?: Function },
 *   logger: { info: Function, debug: Function, error: Function },
 *   requestId: string,
 *   route: string,
 *   node: RuntimeNode,
 *   requestedModel: string,
 *   clientWantsStream: boolean,
 *   fakeStream: boolean,
 *   bodyJson: unknown,
 *   limits: Record<string, number>,
 *   exposeUpstreamInfo: boolean,
 *   state: LoopState,
 *   failoverBudgetMs: number,
 *   requestStartMs: number,
 *   remainingDispatchableAttempts: number,
 *   reqDescriptor: RequestDescriptor,
 *   policy: PolicyConfig,
 *   tierNumber: Tier,
 *   conversionContext: { fallbackProtocol: Protocol, fallbackSurface: Surface, convertedBody: unknown } | null,
 *   tier1ReleaseToken: unknown,
 *   tier1EscapedFromAffinity: boolean,
 *   tier1UpdateAffinity: boolean,
 *   tier1AffinityAccountId: string | null,
 *   tier1EvaluateAffinity: boolean,
 *   tier1Session: string | null,
 *   rng: (() => number) | null,
 *   hedgedAttempt: boolean,
 *   hedgedWithTwin: boolean,
 *   hedgeAbort: { signal: { aborted: boolean, addEventListener: Function }, abort: Function } | null,
 *   attemptDeadlineMs: number,
 *   attemptStartMs: number,
 *   headersMs: number,
 *   ttftMs: number,
 *   upstreamProtocol: Protocol,
 *   surface: Surface,
 * }} AttemptContext
 */

/**
 * Outcome returned by attemptNode / dispatchWithHedge.
 * Exactly one of: committed response, rotate, or stop.
 *
 * @typedef {{
 *   response?: Response,
 *   rotate?: boolean,
 *   stop?: boolean,
 *   budgetCharged?: boolean,
 *   kind?: string,
 *   hedgedAway?: boolean,
 * }} AttemptOutcome
 */

/**
 * @typedef {'rotate' | 'tier_exhausted' | 'budget_exhausted' | 'stop' | 'success'} AttemptResult
 */

/**
 * Per-node runtime state held in node-state.js. The shape is the source
 * of truth for `getNodeState` consumers; every field has an explicit
 * zero-initial default so a fresh state is a valid closed-circuit state.
 *
 * @typedef {{
 *   activeRequests: number,
 *   rpm: { count: number, minute: number },
 *   cooldownUntil: number,
 *   cooldownReason: string | null,
 *   totalFailures: number,
 *   consecutiveFailures: number,
 *   lastTransientFailureAt: number,
 *   circuitState: 'closed' | 'open' | 'half-open',
 *   circuitOpenedAt: number,
 *   probeInFlight: boolean,
 *   probeTtftMs: number,
 *   avgTtftMs: number,
 *   healthScore: number,
 *   healthPenalty: number,
 *   healthUpdatedAt: number,
 *   modelPerf: Map<string, ModelPerfEntry>,
 *   lastSeen: number,
 * }} NodeState
 */

/**
 * @typedef {{
 *   ttftCount: number,
 *   ttftSum: number,
 *   ttftEwma: number,
 *   lastProbeFailureAt: number,
 *   consecutive5xx: number,
 *   consecutiveTimeouts: number,
 *   consecutiveRateLimits: number,
 *   consecutiveSuccesses: number,
 *   cooldownUntil: number,
 *   cooldownScope: 'model' | 'auth' | null,
 *   exhausted: boolean,
 * }} ModelPerfEntry
 */

/**
 * A single decision returned by the scheduler when picking the next
 * candidate for a tier. The shape is shared by all tier pickers
 * (Tier 1 with affinity release token, Tier 2/3 with priority/LRU).
 *
 * @typedef {{
 *   node: RuntimeNode,
 *   raceLost: boolean,
 *   releaseToken?: { accountId: string } | null,
 *   updateAffinity?: boolean,
 *   escapedFromAffinity?: boolean,
 * }} PickedCandidate
 */
