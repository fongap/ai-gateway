#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(rel):
    return (ROOT / rel).read_text(encoding='utf-8')


def write(rel, text):
    (ROOT / rel).write_text(text, encoding='utf-8')


def replace(rel, old, new, count=1):
    text = read(rel)
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f'{rel}: expected {count} occurrences, found {actual}: {old[:100]!r}')
    write(rel, text.replace(old, new, count))


def remove(rel, old, count=1):
    replace(rel, old, '', count)

# ---------------------------------------------------------------------------
# 1. Authorization scope must bound model-family fallback.
# ---------------------------------------------------------------------------
replace(
    'src/request/preflight.ts',
    "import { authorizeModel } from './model-authz.ts';",
    "import { authorizeModel, filterVisibleModels } from './model-authz.ts';",
)
replace(
    'src/request/preflight.ts',
    "  const modelAuthz = authorizeModel(requestedModel, knownModels, authResult);\n  if (modelAuthz.allowed === false) {",
    "  const modelAuthz = authorizeModel(requestedModel, knownModels, authResult);\n  if (modelAuthz.allowed === false) {",
)
replace(
    'src/request/preflight.ts',
    "  // ---- Candidate pool ----\n  const config = loadGatewayConfig(env);",
    "  // The scheduler/fallback catalog is key-scoped as well: internal model-family\n  // fallback may only use models this key is itself allowed to call. This keeps\n  // visible == callable across the entire request, not just at the entry gate.\n  const callableModels = new Set(filterVisibleModels(knownModels, authResult));\n\n  // ---- Candidate pool ----\n  const config = loadGatewayConfig(env);",
)
replace(
    'src/request/preflight.ts',
    "  // Preflight authorizes ONLY the client-requested model. Compatible fallback\n  // aliases are an internal execution detail and must not widen what the key can\n  // request directly. After that authorization succeeds, admit the request when\n  // either the requested alias or one of its closed, compatible family members\n  // has a statically reachable native/protocol-fallback route. Runtime\n  // cooldown/circuit/capacity remains a scheduler concern downstream.",
    "  // Preflight and internal fallback share the same key-scoped callable catalog.\n  // A family member outside the current key's model allowlist is not a candidate,\n  // even when it exists globally. Runtime cooldown/circuit/capacity remains a\n  // scheduler concern downstream.",
)
replace(
    'src/request/preflight.ts',
    "    route, requestedModel, requestDescriptor, tiers, knownModels, env,",
    "    route, requestedModel, requestDescriptor, tiers, knownModels: callableModels, env,",
    count=1,
)
replace(
    'src/request/preflight.ts',
    "    for (const effectiveModel of modelFallbackCandidates(requestedModel, knownModels)) {",
    "    for (const effectiveModel of modelFallbackCandidates(requestedModel, callableModels)) {",
)
replace(
    'src/request/preflight.ts',
    "        knownModels,\n        env,",
    "        knownModels: callableModels,\n        env,",
    count=1,
)
replace(
    'src/request/preflight.ts',
    "    knownModels,\n    feasibility,",
    "    knownModels: callableModels,\n    feasibility,",
)

# ---------------------------------------------------------------------------
# 2. A node/model mapping 404 must not terminate the whole family.
# ---------------------------------------------------------------------------
remove(
    'src/request/handler.ts',
    "      const modelMissingBefore = state.failureKinds.model_missing ?? 0;\n",
)
remove(
    'src/request/handler.ts',
    "\n      // A model-missing 404 is a mapping/capability fact, not transient pool\n      // unavailability. Keep that failure isolated to the (node, model) pair\n      // and do not silently turn it into a different logical model. Model-family\n      // fallback is only the final capacity escape hatch after runtime\n      // availability is exhausted.\n      if ((state.failureKinds.model_missing ?? 0) > modelMissingBefore) {\n        break modelRoundsLoop;\n      }",
)

# ---------------------------------------------------------------------------
# 3. Streaming commit boundary: all OpenAI Chat tiers require real output.
# ---------------------------------------------------------------------------
replace(
    'src/request/attempt/success.ts',
    "// OpenAI Chat Tier 1 uses its meaningful-output predicate while Tier 2/3 keep\n// the original parseable-event boundary. Responses uses response.*.delta.",
    "// OpenAI Chat uses the same meaningful-output predicate in every tier; a\n// role-only / empty delta never closes the transparent-failover boundary.\n// Responses uses response.*.delta.",
)
replace(
    'src/request/attempt/success.ts',
    "      //   openai chat tier1  -> meaningful text/reasoning/tool delta (so a\n      //     role-only or empty delta does NOT close the boundary and is NOT\n      //     recorded as passive TTFT — Tier 1 learns only from real output)\n      //   openai chat tier2/3 -> any parseable non-error event (original rule,\n      //     unchanged — Tier 2/3 are not redesigned here)\n      const isRealOutput = surface === 'messages'\n        ? isAnthropicNativeRealOutput\n        : surface === 'responses' ? isResponsesRealOutput\n        : (surface === 'chat_completions' && node.tier === 'tier-1') ? isOpenAIChatRealOutput\n        : undefined;",
    "      //   openai chat -> meaningful text/reasoning/tool delta in EVERY tier;\n      //     role-only or empty deltas do not close the boundary. Tier 1 still\n      //     remains the only tier that learns passive TTFT in tier1-state.\n      const isRealOutput = surface === 'messages'\n        ? isAnthropicNativeRealOutput\n        : surface === 'responses' ? isResponsesRealOutput\n        : surface === 'chat_completions' ? isOpenAIChatRealOutput\n        : undefined;",
)

# ---------------------------------------------------------------------------
# 4. HTTP 200 non-JSON is a real protocol failure, not a permanent neutral.
# ---------------------------------------------------------------------------
replace(
    'src/reliability/classify.ts',
    "  // An HTTP 200 response whose body was not parseable as the expected JSON\n  // shape. Neutral end (the upstream WAS contacted), no circuit penalty.\n  NON_JSON_BODY: 'upstream_200_non_json_body',",
    "  // HTTP 200 with a body that violates the expected JSON protocol. This is\n  // an upstream/proxy failure, not a client-success neutral.\n  NON_JSON_BODY: 'upstream_200_non_json_body',",
)
replace(
    'src/reliability/classify.ts',
    "// The upstream returned HTTP 200 with a body that could not be parsed as\n// the expected JSON shape. Neutral end (the upstream WAS contacted, so do\n// not roll back the RPM slot), no circuit penalty, no cooldown.\nexport function classifyNonJsonBody(): FailureClassification {\n  return { kind: KIND.NON_JSON_BODY, action: 'neutral', cooldownMs: 0, counted: false };\n}",
    "// The upstream returned HTTP 200 with a body that could not be parsed as\n// the expected protocol JSON. Rotate, apply a short node cooldown, and count it\n// as a transient failure so a persistent WAF/proxy HTML response can open the\n// circuit instead of being selected again on every new client request.\nexport function classifyNonJsonBody(): FailureClassification {\n  return { kind: KIND.NON_JSON_BODY, action: 'rotate', cooldownMs: 5_000, counted: true };\n}",
)
replace(
    'src/request/attempt/success.ts',
    "    } catch {\n      return rotateWithNeutralEnd(state, node, classifyNonJsonBody().kind, c);\n    }",
    "    } catch {\n      const classification = classifyNonJsonBody();\n      recordOutcome(state, node, classification, c, { latencyMs, status: upstream.status, diagnostic: text });\n      return { rotate: true, kind: classification.kind };\n    }",
)

# ---------------------------------------------------------------------------
# 5. Hedge object means enabled unless explicitly false.
# ---------------------------------------------------------------------------
replace(
    'src/config/policies.ts',
    "  const out: { enabled?: boolean, delayMs?: number, tiers?: Array<'tier1' | 'tier2' | 'tier3'> } = {};",
    "  const out: { enabled?: boolean, delayMs?: number, tiers?: Array<'tier1' | 'tier2' | 'tier3'> } = { enabled: true };",
)
replace(
    'src/request/attempt/hedge.ts',
    "// Hedging is EXPLICIT OPT-IN: hedge.enabled must be true for hedging to\n// activate. The default and stable built-in policies enable hedging for\n// Tier 1 only. fast and long-reasoning keep hedging disabled. Operators\n// can override via POLICIES_CONFIG.",
    "// A hedge object enables hedging by default; hedge.enabled=false disables it.\n// The default and stable built-ins hedge Tier 1 only, while fast and\n// long-reasoning explicitly disable it.",
)
replace(
    'src/request/attempt/hedge.ts',
    "  // Resolve effective hedge config: policy.hedge (per-model) overrides\n  // the global env defaults. Hedging is EXPLICIT OPT-IN: hedge.enabled must\n  // be true for hedging to activate. default and stable enable hedging for\n  // Tier 1 only; fast and long-reasoning keep it disabled.\n  const hedgePolicy = args.policy?.hedge ?? null;\n  if (!hedgePolicy || hedgePolicy.enabled !== true) return attemptNode(args);",
    "  // Resolve effective hedge config: policy.hedge (per-model) overrides\n  // global env defaults. The presence of a hedge object enables it unless the\n  // operator explicitly sets enabled=false.\n  const hedgePolicy = args.policy?.hedge ?? null;\n  if (!hedgePolicy || hedgePolicy.enabled === false) return attemptNode(args);",
)

# ---------------------------------------------------------------------------
# 6. Strict node schema: remove legacy limits and implicit protocol/surfaces.
# ---------------------------------------------------------------------------
replace(
    'src/config/nodes.ts',
    "// `limits` is retired from active admission. Existing deployments that still\n// carry a syntactically-valid legacy limits object remain serviceable and get a\n// deprecation diagnostic, but concurrency/RPM values no longer control routing.\n// Capacity is learned from live in-flight pressure, 429/cooldown, health/circuit\n// and latency signals instead of operator-guessed ceilings.\n//\n",
    "// Node-level limits are intentionally absent. Capacity is learned from live\n// in-flight pressure, 429/cooldown, health/circuit and latency signals rather\n// than operator-guessed concurrency/RPM ceilings.\n//\n",
)
replace(
    'src/config/nodes.ts',
    "// Missing `protocol` or `surfaces` is accepted with deprecated defaults and a\n// diagnostic so existing configuration remains serviceable while operators\n// make those fields explicit.\n//\n",
    "// `protocol` and `surfaces` are required. There are no implicit transport\n// defaults: an ambiguous node is invalid configuration.\n//\n",
)
replace(
    'src/config/nodes.ts',
    "// `limits` is the sole legacy migration field. Unknown top-level fields still\n// fail fast; known legacy limit keys are validated only to catch obvious typos.\nconst ALLOWED_NODE_FIELDS = new Set(['id', 'provider', 'protocol', 'surfaces', 'base_url', 'priority', 'models', 'limits']);\nconst ALLOWED_LIMITS_FIELDS = new Set(['concurrency', 'rpm', 'rpm_mode']);\nconst RPM_MODES = new Set(['soft', 'hard', 'local_hard']);",
    "const ALLOWED_NODE_FIELDS = new Set(['id', 'provider', 'protocol', 'surfaces', 'base_url', 'priority', 'models']);",
)
remove(
    'src/config/nodes.ts',
    "const DEFAULT_SURFACES = new Map<Protocol, string[]>([\n  ['openai', ['chat_completions']],\n  ['anthropic', ['messages']],\n]);\n",
)
replace(
    'src/config/nodes.ts',
    "      diagnostics.push(`node \"${id}\": unknown field \"${key}\" (allowed: id, provider, protocol, surfaces, base_url, priority, models; legacy limits is ignored)`);",
    "      diagnostics.push(`node \"${id}\": unknown field \"${key}\" (allowed: id, provider, protocol, surfaces, base_url, priority, models)`);",
)
remove(
    'src/config/nodes.ts',
    "  const legacyLimits = parseLimits(rec.limits, id, diagnostics);\n  if (legacyLimits === null) return null;\n  if ('limits' in rec) diagnostics.push(`node \"${id}\": limits is deprecated and ignored; remove it from the node config`);\n",
)
replace(
    'src/config/nodes.ts',
    "    models,\n    // Transitional internal shape: legacy values may remain visible to tests /\n    // diagnostics, but no node-level RPM value is projected, so RPM admission\n    // is disabled. Tier 1 primary selection separately ignores concurrency as\n    // a hard gate; Tier 2/3 only use activeRequests as a ranking signal.\n    limits: {\n      concurrency: legacyLimits.concurrency ?? 2,\n      ...(legacyLimits.rpm !== undefined ? { rpmMode: legacyLimits.rpmMode ?? 'hard' } : {}),\n    },",
    "    models,",
)
replace(
    'src/config/nodes.ts',
    "  if (raw === undefined || raw === null) {\n    diagnostics.push(`node \"${nodeId}\": protocol is implicit and defaults to \"openai\"; please configure it explicitly`);\n    return 'openai';\n  }",
    "  if (raw === undefined || raw === null) {\n    diagnostics.push(`node \"${nodeId}\": protocol is required`);\n    return null;\n  }",
)
replace(
    'src/config/nodes.ts',
    "  if (raw === undefined || raw === null) {\n    const def = DEFAULT_SURFACES.get(protocol) as string[];\n    diagnostics.push(`node \"${nodeId}\": surfaces is implicit and defaults to [${def.map((s) => `\"${s}\"`).join(', ')}]; please configure it explicitly`);\n    return def.slice() as Surface[];\n  }",
    "  if (raw === undefined || raw === null) {\n    diagnostics.push(`node \"${nodeId}\": surfaces is required`);\n    return null;\n  }",
)
# Remove parseLimits function as one exact block.
text = read('src/config/nodes.ts')
start = text.index('function parseLimits(')
end = text.index('\nfunction normalizeModels(', start)
write('src/config/nodes.ts', text[:start] + text[end+1:])

replace(
    'src/types/node.ts',
    "  models: NodeModelMap,\n  limits: {\n    concurrency: number,\n    rpm?: number,\n    rpmMode?: 'soft' | 'hard',\n  },",
    "  models: NodeModelMap,",
)

# ---------------------------------------------------------------------------
# 7. Remove RPM/concurrency admission from schedulers and reliability state.
# ---------------------------------------------------------------------------
# Tier 1 scheduler: remove soft-only shim.
text = read('src/scheduler/tier1-scheduler.ts')
start = text.index('const CONSERVATIVE_ATTEMPT_COST_MS = 500;')
shim_start = text.index('const SOFT_ONLY_CONCURRENCY', start)
shim_end = text.index('\n// Remaining deadline too small', shim_start)
text = text[:shim_start] + text[shim_end+1:]
text = text.replace('isTier1Eligible(withoutHardConcurrency(node), req, now, knownModels)', 'isTier1Eligible(node, req, now, knownModels)')
text = text.replace('    withoutHardConcurrency(node), req.model, eligible,', '    node, req.model, eligible,')
text = text.replace('claimTier1Slot(withoutHardConcurrency(chosen), now, req.model)', 'claimTier1Slot(chosen, now, req.model)')
text = text.replace('// Concurrency is deliberately soft: live in-flight work affects ranking and\n// hedge admission, but an operator-guessed limits.concurrency value never makes\n// a primary candidate ineligible. Hard RPM remains available when explicitly\n// configured.\n//\n', '// Live in-flight work is a soft ranking/hedge-admission signal only. There is\n// no configured node concurrency or RPM admission ceiling.\n//\n')
write('src/scheduler/tier1-scheduler.ts', text)

# tier-loop shim removal.
text = read('src/request/tier-loop.ts')
start = text.index('const SOFT_ONLY_CONCURRENCY')
end = text.index('\nexport type TierPickResult', start)
replacement = '''function tier1Dispatchable(\n  nodes: ReadonlyArray<RuntimeNode>,\n  req: RoutableRequest,\n  attempted: Set<string>,\n  now: number,\n  knownModels: ReadonlySet<string>,\n): boolean {\n  return tier1HasDispatchableNode(nodes, req, attempted, now, knownModels);\n}\n\nfunction tier1LiveCount(\n  nodes: ReadonlyArray<RuntimeNode>,\n  req: RoutableRequest,\n  attempted: Set<string>,\n  now: number,\n  knownModels: ReadonlySet<string>,\n): number {\n  return tier1CountDispatchableNodes(nodes, req, attempted, now, knownModels);\n}\n'''
write('src/request/tier-loop.ts', text[:start] + replacement + text[end+1:])

# Tier2/3 scheduler: collapse to one best candidate and remove RPM exports/gates.
text = read('src/scheduler/scheduler.ts')
text = text.replace('import { peekAvailability, acquireSlot, getNodeState, rpmUsage, isModelCooling, getModelPerf }', 'import { peekAvailability, acquireSlot, getNodeState, isModelCooling, getModelPerf }')
start = text.index('function underRpmCap(')
end = text.index('\n// Pick and claim the best eligible node', start)
text = text[:start] + text[end+1:]
text = text.replace("  let bestUncapped: RuntimeNode | null = null;\n  let bestUncappedState: NodeState | null = null;\n", '')
old_loop = '''    const s = getNodeState(node.id);\n    if (underRpmCap(node, now)) {\n      // bestState is assigned on every assignment of best (single-writer\n      // invariant of this loop), so the assertion only restates that pair.\n      if (!best || betterThan(s, node, bestState as NodeState, best, req.model, now)) {\n        best = node;\n        bestState = s;\n      }\n    }\n    // Only SOFT-capped (or uncapped) nodes may serve past their counter.\n    if (!isHardRpmExhausted(node, now)) {\n      if (!bestUncapped || betterThan(s, node, bestUncappedState as NodeState, bestUncapped, req.model, now)) {\n        bestUncapped = node;\n        bestUncappedState = s;\n      }\n    }\n'''
new_loop = '''    const s = getNodeState(node.id);\n    // bestState is assigned on every assignment of best (single-writer\n    // invariant of this loop), so the assertion only restates that pair.\n    if (!best || betterThan(s, node, bestState as NodeState, best, req.model, now)) {\n      best = node;\n      bestState = s;\n    }\n'''
if old_loop not in text: raise SystemExit('scheduler pick loop drift')
text = text.replace(old_loop, new_loop, 1)
text = text.replace('  const chosen = best || bestUncapped;', '  const chosen = best;')
# Remove deferred-capacity function entirely.
start = text.index('export function tierHasDeferredCapacity(')
end = text.index('\n// DISPATCHABLE capacity', start)
text = text[:start] + text[end+1:]
text = text.replace('    if (isHardRpmExhausted(node, now)) continue;\n', '')
text = text.replace('// `activeRequests` is a SOFT load signal. The scheduler no longer turns an\n// operator-guessed limits.concurrency value into a hard eligibility gate; a\n// busy node loses to a less-busy peer but remains usable when it is the only\n// healthy capacity left. Existing hard RPM behavior is preserved for operators\n// that explicitly configured it.\n//\n', '// `activeRequests` is a SOFT load signal. There is no configured node-level\n// concurrency or RPM admission ceiling; a busy node loses to a less-busy peer\n// but remains usable when it is the only healthy capacity left.\n//\n')
# Remove RPM semantics comment block if present.
text = text.replace('// RPM semantics are unchanged:\n//   hard (default when limits.rpm is set): an exhausted node is NOT a fallback\n//     candidate — the gateway would knowingly exceed the configured quota.\n//   soft ("rpm_mode":"soft"): exhausted nodes remain last-resort candidates.\n//\n', '')
write('src/scheduler/scheduler.ts', text)

# Node state: remove per-node RPM bucket machinery and reservation call.
text = read('src/reliability/node-state.ts')
start = text.index('// Per-node per-minute request counters')
end = text.index('\nconst nodeState = new Map', start)
text = text[:start] + text[end+1:]
text = text.replace('  noteRpmRequest(nodeId, now);\n', '')
write('src/reliability/node-state.ts', text)

# Tier1 state: remove RPM bucket machinery and all limits gates.
text = read('src/reliability/tier1-state.ts')
start = text.index('type Tier1RpmBucket = {')
end = text.index('\nfunction newModelRuntime()', start)
text = text[:start] + text[end+1:]
start = text.index('function tier1RpmCapacity(')
end = text.index('\nexport function claimTier1Slot', start)
text = text[:start] + '''function recoveryGateMs(): number {\n  return TIER1_429_PROBE_GATE_MS;\n}\n''' + text[end+1:]
text = text.replace('  if (account.inFlight >= node.limits.concurrency) return false;\n\n  const rpm = node.limits.rpm ?? 0;\n  const hardRpm = rpm > 0 && node.limits.rpmMode !== \'soft\';\n  if (hardRpm && !noteTier1Rpm(node.id, rpm, now)) return false;\n\n', '')
text = text.replace('now + recoveryGateMs(rpm)', 'now + recoveryGateMs()')
text = text.replace('  if (account.inFlight >= node.limits.concurrency) return false;\n  if (node.limits.rpm && node.limits.rpmMode !== \'soft\'\n    && tier1RpmWaitMs(node.id, node.limits.rpm, now) > 0) return false;\n', '')
write('src/reliability/tier1-state.ts', text)

# Attempt dispatch/outcome: remove distributed node RPM quota gate and rollbacks.
text = read('src/request/attempt/dispatch.ts')
text = text.replace('import { recordNeutralEnd, rollbackRpmBucket, bumpNodeCounters }', 'import { recordNeutralEnd, bumpNodeCounters }')
text = text.replace('import { releaseTier1Slot, rollbackTier1Rpm }', 'import { releaseTier1Slot }')
text = text.replace('classifyClientAbort, classifyPreDispatchRateLimit, classifyPreDispatchInvalidBaseUrl, classifyHedgeRaceLoss', 'classifyClientAbort, classifyPreDispatchInvalidBaseUrl, classifyHedgeRaceLoss')
text = text.replace('import { recordOutcome, rotateWithNeutralEnd, noteFailure }', 'import { recordOutcome, rotateWithNeutralEnd }')
start = text.index('  // ---- Optional distributed rate shaping')
end = text.index('  // Protocol-aware upstream headers:', start)
text = text[:start] + text[end:]
text = text.replace('  if (outcome.response?.status === 200) {', '  if (outcome.response?.ok) {')
text = text.replace(' kind=ok status=200`', ' kind=ok status=${outcome.response.status}`')
write('src/request/attempt/dispatch.ts', text)

text = read('src/request/attempt/outcome.ts')
text = text.replace('  recordNeutralEnd, rollbackRpmBucket, recordModelMissing,', '  recordNeutralEnd, recordModelMissing,')
text = text.replace('  rollbackTier1Rpm, recordTier1ProviderModelRateLimit,', '  recordTier1ProviderModelRateLimit,')
text = text.replace('    if (preDispatch) rollbackTier1Rpm(node.id);\n    else bumpNodeCounters(node.id, { requests: 1 });', '    if (!preDispatch) bumpNodeCounters(node.id, { requests: 1 });')
text = text.replace("    // Pre-dispatch neutrals also never touched the network, so the RPM reservation\n    // acquireSlot made must be returned to the bucket — otherwise a structurally\n    // broken node silently burns its own per-minute RPM quota on traffic it never\n    // sent. Post-dispatch neutrals (200-with-non-json) keep the charge: the\n    // upstream WAS contacted.\n    if (preDispatch) rollbackRpmBucket(node.id);\n", '')
write('src/request/attempt/outcome.ts', text)

# Remove obsolete pre-dispatch rate-limit classification helper.
text = read('src/reliability/classify.ts')
start = text.index('// Distributed rate-limiter binding denied the request before dispatch.')
end = text.index('\n// The node\'s base_url is structurally invalid', start)
text = text[:start] + text[end+1:]
write('src/reliability/classify.ts', text)

# ---------------------------------------------------------------------------
# 8. Policy timeout must fit whole-request budget.
# ---------------------------------------------------------------------------
replace(
    'src/config/policies.ts',
    "import { readEnv } from './env.ts';",
    "import { readEnv } from './env.ts';\nimport { getLimits } from './timeouts.ts';",
)
replace(
    'src/config/policies.ts',
    "        const firstEventTimeoutMs = cfg.first_event_timeout_ms === undefined ? (base?.firstEventTimeoutMs ?? null) : parseFirstEventTimeoutMs(cfg.first_event_timeout_ms, key, errors);",
    "        const firstEventTimeoutMs = cfg.first_event_timeout_ms === undefined ? (base?.firstEventTimeoutMs ?? null) : parseFirstEventTimeoutMs(cfg.first_event_timeout_ms, key, errors);\n        if (firstEventTimeoutMs !== null && firstEventTimeoutMs > getLimits(env).failoverBudgetMs) {\n          errors.push(`POLICIES_CONFIG: \"${key}\": first_event_timeout_ms (${firstEventTimeoutMs}) exceeds FAILOVER_BUDGET_MS (${getLimits(env).failoverBudgetMs})`);\n        }",
)

# ---------------------------------------------------------------------------
# 9. Migration checker: verify every CREATE occurrence, not the first one only.
# ---------------------------------------------------------------------------
replace(
    'scripts/migrations-check.mjs',
    "    const createMatches = upper.match(/\\bCREATE\\s+(TABLE|INDEX|UNIQUE\\s+INDEX)\\b/g) || [];\n    for (const stmt of createMatches) {\n      const offset = upper.indexOf(stmt);\n      const after = upper.slice(offset, offset + 200);",
    "    const createMatches = upper.matchAll(/\\bCREATE\\s+(TABLE|INDEX|UNIQUE\\s+INDEX)\\b/g);\n    for (const match of createMatches) {\n      const offset = match.index ?? 0;\n      const after = upper.slice(offset, offset + 200);",
)

# Basic textual invariants before the real CI/typecheck.
for rel, forbidden in [
    ('src/config/nodes.ts', 'parseLimits('),
    ('src/types/node.ts', 'limits:'),
    ('src/scheduler/tier1-scheduler.ts', 'withoutHardConcurrency'),
    ('src/request/tier-loop.ts', 'SOFT_ONLY_CONCURRENCY'),
    ('src/request/attempt/dispatch.ts', 'QUOTA_RATE_LIMITER'),
]:
    if forbidden in read(rel):
        raise SystemExit(f'{rel}: forbidden residue {forbidden!r}')

print('reliability convergence patch applied')
