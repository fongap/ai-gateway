#!/usr/bin/env python3
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def rd(p): return (ROOT/p).read_text(encoding='utf-8')
def wr(p,s): (ROOT/p).write_text(s,encoding='utf-8')
def rep(p,a,b,n=1):
    s=rd(p); c=s.count(a)
    if c!=n: raise SystemExit(f'{p}: expected {n}, found {c}: {a[:120]!r}')
    wr(p,s.replace(a,b,n))

# ---------------------------------------------------------------------------
# Tier 2/3 exact-once node lease.
# ---------------------------------------------------------------------------
rep('src/reliability/node-state.ts',
'''// Commit a selection: claims a concurrency slot. When the node was ready to\n// be probed, this request becomes THE single half-open probe.\n// Must only be called after peekAvailability returned 'yes'|'probe'.\nexport function acquireSlot(nodeId: string, now: number = Date.now()): boolean {\n  const s = getNodeState(nodeId);\n  if (peekAvailability(nodeId, now) === 'no') return false;\n  if (s.circuitState === 'open' && s.cooldownUntil <= now) {\n    s.circuitState = 'half-open';\n    s.probeInFlight = true;\n  } else if (s.circuitState === 'half-open' && !s.probeInFlight) {\n    s.probeInFlight = true;\n  }\n  s.activeRequests++;\n  s.totalRequests++;\n  s.lastUsedAt = now;\n  maybeCleanup(now);\n  return true;\n}\n''',
'''export type NodeReleaseToken = { nodeId: string, released: boolean };\n\n// Claim a Tier 2/3 execution lease. The returned token is the ownership proof\n// for exactly one activeRequests slot; every terminal path releases this token\n// once, including unexpected programming exceptions.\nexport function claimSlot(nodeId: string, now: number = Date.now()): NodeReleaseToken | null {\n  const s = getNodeState(nodeId);\n  if (peekAvailability(nodeId, now) === 'no') return null;\n  if (s.circuitState === 'open' && s.cooldownUntil <= now) {\n    s.circuitState = 'half-open';\n    s.probeInFlight = true;\n  } else if (s.circuitState === 'half-open' && !s.probeInFlight) {\n    s.probeInFlight = true;\n  }\n  s.activeRequests++;\n  s.totalRequests++;\n  s.lastUsedAt = now;\n  maybeCleanup(now);\n  return { nodeId, released: false };\n}\n\n// Standalone tests and diagnostic callers still use a boolean claim; the hot\n// request path uses claimSlot() so release ownership is explicit.\nexport function acquireSlot(nodeId: string, now: number = Date.now()): boolean {\n  return claimSlot(nodeId, now) !== null;\n}\n''')

# Make all Tier2/3 terminal mutations token-aware.
s=rd('src/reliability/node-state.ts')
s=s.replace('export function recordSuccess(nodeId: string, latencyMs: number, model: string, now: number = Date.now()): void {\n  const s = releaseAndReturn(nodeId);',
            'export function recordSuccess(nodeId: string, latencyMs: number, model: string, now: number = Date.now(), releaseToken?: NodeReleaseToken | null): void {\n  const s = releaseAndReturn(nodeId, releaseToken);')
s=s.replace('export function recordFailure(nodeId: string, { counted = false, cooldownMs = 0, reason = null }: { counted?: boolean, cooldownMs?: number, reason?: string | null } = {}, now: number = Date.now()): void {\n  const s = releaseAndReturn(nodeId);',
            'export function recordFailure(nodeId: string, { counted = false, cooldownMs = 0, reason = null }: { counted?: boolean, cooldownMs?: number, reason?: string | null } = {}, now: number = Date.now(), releaseToken?: NodeReleaseToken | null): void {\n  const s = releaseAndReturn(nodeId, releaseToken);')
s=s.replace('export function recordNeutralEnd(nodeId: string): void {\n  const s = releaseAndReturn(nodeId);',
            'export function recordNeutralEnd(nodeId: string, releaseToken?: NodeReleaseToken | null): void {\n  const s = releaseAndReturn(nodeId, releaseToken);')
s=s.replace('export function recordModelMissing(nodeId: string, model: string, cooldownMs: number = MODEL_MISSING_COOLDOWN_MS, now: number = Date.now()): void {\n  const s = releaseAndReturn(nodeId);',
            'export function recordModelMissing(nodeId: string, model: string, cooldownMs: number = MODEL_MISSING_COOLDOWN_MS, now: number = Date.now(), releaseToken?: NodeReleaseToken | null): void {\n  const s = releaseAndReturn(nodeId, releaseToken);')
s=s.replace('function releaseAndReturn(nodeId: string): NodeState {\n  const s = getNodeState(nodeId);\n  s.activeRequests = Math.max(0, s.activeRequests - 1);\n  return s;\n}',
'''function releaseAndReturn(nodeId: string, releaseToken?: NodeReleaseToken | null): NodeState {\n  const s = getNodeState(nodeId);\n  if (releaseToken) {\n    if (releaseToken.nodeId !== nodeId || releaseToken.released) return s;\n    releaseToken.released = true;\n  }\n  s.activeRequests = Math.max(0, s.activeRequests - 1);\n  return s;\n}\n\nexport function releaseNodeSlot(nodeId: string, releaseToken: NodeReleaseToken | null | undefined): void {\n  releaseAndReturn(nodeId, releaseToken);\n}''')
wr('src/reliability/node-state.ts',s)

# Scheduler returns lease ownership with a successful Tier2/3 pick.
rep('src/scheduler/scheduler.ts',
"import { peekAvailability, acquireSlot, getNodeState, isModelCooling, getModelPerf } from '../reliability/node-state.ts';",
"import { peekAvailability, claimSlot, getNodeState, isModelCooling, getModelPerf } from '../reliability/node-state.ts';")
rep('src/scheduler/scheduler.ts',
"  if (!acquireSlot(chosen.id, now)) return { raceLost: true, raceLostNodeId: chosen.id };\n  return { node: chosen };",
"  const nodeReleaseToken = claimSlot(chosen.id, now);\n  if (!nodeReleaseToken) return { raceLost: true, raceLostNodeId: chosen.id };\n  return { node: chosen, nodeReleaseToken };")

rep('src/types/scheduler.ts',
"import type { Protocol, Surface } from './protocol.ts';",
"import type { Protocol, Surface } from './protocol.ts';\nimport type { NodeReleaseToken } from '../reliability/node-state.ts';")
rep('src/types/scheduler.ts',
"  releaseToken?: { accountId: string, released: boolean } | null,",
"  releaseToken?: { accountId: string, released: boolean } | null,\n  nodeReleaseToken?: NodeReleaseToken | null,")

rep('src/types/request.ts',
"import type { FailureKind } from '../reliability/classify.ts';",
"import type { FailureKind } from '../reliability/classify.ts';\nimport type { NodeReleaseToken } from '../reliability/node-state.ts';")
rep('src/types/request.ts',
"  tier1ReleaseToken: { accountId: string, released: boolean } | null,",
"  tier1ReleaseToken: { accountId: string, released: boolean } | null,\n  nodeReleaseToken: NodeReleaseToken | null,")

rep('src/request/handler.ts',
"        tier1ReleaseToken: pick.tier1ReleaseToken || null,",
"        tier1ReleaseToken: pick.tier1ReleaseToken || null,\n        nodeReleaseToken: pick.nodeReleaseToken || null,")

rep('src/request/attempt/hedge.ts',
"    tier1ReleaseToken: twinPick.releaseToken || null,",
"    tier1ReleaseToken: twinPick.releaseToken || null,\n    nodeReleaseToken: twinPick.nodeReleaseToken || null,")

# Every normal outcome marks the Tier2/3 lease released.
s=rd('src/request/attempt/outcome.ts')
s=s.replace('recordNeutralEnd(node.id);','recordNeutralEnd(node.id, c.nodeReleaseToken);')
s=s.replace('recordModelMissing(node.id, state.requestedModel, classification.cooldownMs || 0);','recordModelMissing(node.id, state.requestedModel, classification.cooldownMs || 0, Date.now(), c.nodeReleaseToken);')
s=s.replace('recordFailure(node.id, { counted: classification.counted, cooldownMs: classification.cooldownMs || 0, reason: classification.kind });','recordFailure(node.id, { counted: classification.counted, cooldownMs: classification.cooldownMs || 0, reason: classification.kind }, Date.now(), c.nodeReleaseToken);')
wr('src/request/attempt/outcome.ts',s)

s=rd('src/request/attempt/observability.ts')
s=s.replace('recordSuccess(node.id, latencyMs, c.state?.requestedModel);','recordSuccess(node.id, latencyMs, c.state?.requestedModel, Date.now(), c.nodeReleaseToken);')
s=s.replace("recordFailure(node.id, { counted: c.counted, cooldownMs: c.cooldownMs, reason: c.kind });","recordFailure(node.id, { counted: c.counted, cooldownMs: c.cooldownMs, reason: c.kind }, Date.now(), c.nodeReleaseToken);")
s=s.replace(': recordNeutralEnd(node.id),', ': recordNeutralEnd(node.id, c.nodeReleaseToken),')
wr('src/request/attempt/observability.ts',s)

# Unexpected throw finalizer: releases exactly once; token-aware normal outcomes
# make this safe even if the exception occurs after a regular terminal release.
rep('src/request/attempt/dispatch.ts',
"import { recordNeutralEnd, bumpNodeCounters } from '../../reliability/node-state.ts';",
"import { recordNeutralEnd, bumpNodeCounters, releaseNodeSlot } from '../../reliability/node-state.ts';")
old='''export async function attemptNode(c: AttemptContext): Promise<AttemptOutcome> {\n  const outcome = await dispatchAttempt(c);\n  if ('terminal' in outcome && outcome.terminal) return outcome.outcome;\n  if (!outcome.response.ok) return handleUpstreamError(c, outcome.response, outcome.latencyMs);\n  return handleSuccessfulResponse(c, outcome.response, outcome.latencyMs);\n}\n'''
new='''export async function attemptNode(c: AttemptContext): Promise<AttemptOutcome> {\n  try {\n    const outcome = await dispatchAttempt(c);\n    if ('terminal' in outcome && outcome.terminal) return outcome.outcome;\n    if (!outcome.response.ok) return handleUpstreamError(c, outcome.response, outcome.latencyMs);\n    return handleSuccessfulResponse(c, outcome.response, outcome.latencyMs);\n  } catch (error) {\n    // Normal failures are classified below dispatchAttempt/handleSuccessfulResponse.\n    // This catch is only the last-resort programming-error boundary. Release the\n    // scheduler claim exactly once before propagating the unexpected exception.\n    if (c.node.tier === 'tier-1') releaseTier1Slot(c.node.id, c.tier1ReleaseToken);\n    else releaseNodeSlot(c.node.id, c.nodeReleaseToken);\n    c.logger.error(`unexpected attempt error node=${c.node.id}: ${error?.message || error}`);\n    throw error;\n  }\n}\n'''
if old not in rd('src/request/attempt/dispatch.ts'): raise SystemExit('attemptNode drift')
wr('src/request/attempt/dispatch.ts',rd('src/request/attempt/dispatch.ts').replace(old,new,1))

# ---------------------------------------------------------------------------
# Migration checker regression helper/test.
# ---------------------------------------------------------------------------
s=rd('scripts/migrations-check.mjs')
old='''function checkIdempotent(files) {\n  for (const f of files) {\n    const sql = fs.readFileSync(path.join(migDir, f), 'utf8');\n    const upper = sql.toUpperCase();\n    const createMatches = upper.matchAll(/\\bCREATE\\s+(TABLE|INDEX|UNIQUE\\s+INDEX)\\b/g);\n    for (const match of createMatches) {\n      const offset = match.index ?? 0;\n      const after = upper.slice(offset, offset + 200);\n      assert.ok(after.includes('IF NOT EXISTS'),\n        `${f}: every CREATE must use IF NOT EXISTS so re-applies are no-ops (D1 has no migrations table)`);\n    }\n  }\n}\n'''
new='''export function assertIdempotentCreates(sql, file = 'migration.sql') {\n  const upper = String(sql).toUpperCase();\n  const createMatches = upper.matchAll(/\\bCREATE\\s+(TABLE|INDEX|UNIQUE\\s+INDEX)\\b/g);\n  for (const match of createMatches) {\n    const offset = match.index ?? 0;\n    const after = upper.slice(offset, offset + 200);\n    assert.ok(after.includes('IF NOT EXISTS'),\n      `${file}: every CREATE must use IF NOT EXISTS so re-applies are no-ops (D1 has no migrations table)`);\n  }\n}\n\nfunction checkIdempotent(files) {\n  for (const f of files) {\n    assertIdempotentCreates(fs.readFileSync(path.join(migDir, f), 'utf8'), f);\n  }\n}\n'''
if old not in s: raise SystemExit('migration helper drift')
s=s.replace(old,new,1)
# Guard CLI execution so tests can import helper without running repo governance.
old_tail='''try {\n  run();\n  console.log('migrations governance check: PASSED');\n} catch (error) {\n  console.error('migrations governance check: FAILED');\n  console.error(error?.message || error);\n  process.exit(1);\n}\n'''
new_tail='''const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);\nif (invokedAsScript) {\n  try {\n    run();\n    console.log('migrations governance check: PASSED');\n  } catch (error) {\n    console.error('migrations governance check: FAILED');\n    console.error(error?.message || error);\n    process.exit(1);\n  }\n}\n'''
if old_tail not in s: raise SystemExit('migration tail drift')
wr('scripts/migrations-check.mjs',s.replace(old_tail,new_tail,1))

# Append migration regression and exact-once lease regression to existing tests.
s=rd('tests/migrations-check-test.mjs')
s=s.replace("import assert from 'node:assert/strict';", "import assert from 'node:assert/strict';\nimport { assertIdempotentCreates } from '../scripts/migrations-check.mjs';")
s += '''\nassert.doesNotThrow(() => assertIdempotentCreates(\n  'CREATE TABLE IF NOT EXISTS a (id INTEGER); CREATE INDEX IF NOT EXISTS idx_a ON a(id);',\n  'good.sql',\n));\nassert.throws(() => assertIdempotentCreates(\n  'CREATE TABLE IF NOT EXISTS a (id INTEGER); CREATE TABLE b (id INTEGER);',\n  'bad-second-create.sql',\n), /every CREATE must use IF NOT EXISTS/);\nconsole.log('ok - every CREATE occurrence is checked independently');\n'''
wr('tests/migrations-check-test.mjs',s)

# Dedicated node lease test: second release cannot steal another active slot.
s=rd('tests/request-reliability-test.mjs')
insert="""\nawait test('node release token is exactly-once and cannot decrement a peer slot', async () => {\n  const { claimSlot, releaseNodeSlot } = await import('../src/reliability/node-state.ts');\n  __resetAllStateForTests();\n  const t1 = claimSlot('lease-node', 1000);\n  const t2 = claimSlot('lease-node', 1001);\n  assert.ok(t1 && t2);\n  assert.equal(getNodeState('lease-node').activeRequests, 2);\n  releaseNodeSlot('lease-node', t1);\n  assert.equal(getNodeState('lease-node').activeRequests, 1);\n  releaseNodeSlot('lease-node', t1);\n  assert.equal(getNodeState('lease-node').activeRequests, 1, 'double release must be a no-op');\n  releaseNodeSlot('lease-node', t2);\n  assert.equal(getNodeState('lease-node').activeRequests, 0);\n});\n\n"""
marker='// ---- Per-attempt header-wait budget split'
if marker not in s: raise SystemExit('request reliability marker drift')
s=s.replace(marker,insert+marker,1)
wr('tests/request-reliability-test.mjs',s)

print('pass4 applied')
