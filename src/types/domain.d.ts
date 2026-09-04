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
 * @typedef {{
 *   ok: true,
 *   node: RuntimeNode,
 *   response: Response,
 *   ttftMs?: number,
 *   usage?: {
 *     inputTokens: number,
 *     outputTokens: number,
 *     totalTokens: number,
 *   } | null,
 *   attempts: number,
 * }} AttemptSuccess
 */

/**
 * @typedef {{
 *   ok: false,
 *   kind: 'rate_limit' | 'server' | 'timeout' | 'first_event' |
 *         'client_abort' | 'model_missing' | 'endpoint_not_found' |
 *         'auth_fail' | 'malformed' | 'first_event_timeout' | 'unknown',
 *   status: number,
 *   counted: boolean,
 *   headersMs: number,
 *   latencyMs: number,
 *   detail?: string,
 *   nodeId?: string,
 * }} AttemptFailure
 *
 *   counted=true  -> node state mutated (cooldown / circuit / RPM)
 *   counted=false -> neutral outcome (client abort, distributed-denied, etc.)
 */

/**
 * @typedef {AttemptSuccess | AttemptFailure} AttemptOutcome
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

export {};
