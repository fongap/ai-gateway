#!/usr/bin/env python3
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def rd(p): return (ROOT/p).read_text(encoding='utf-8')
def wr(p,s): (ROOT/p).write_text(s,encoding='utf-8')
def rep(p,a,b,n=1):
    s=rd(p); c=s.count(a)
    if c!=n: raise SystemExit(f'{p}: expected {n}, found {c}: {a[:120]!r}')
    wr(p,s.replace(a,b,n))

# Tier 2/3 scheduler lease must survive the tier-aware picker wrapper.
rep('src/request/tier-loop.ts',
"  tier1ReleaseToken?: { accountId: string, released: boolean } | null,",
"  tier1ReleaseToken?: { accountId: string, released: boolean } | null,\n  nodeReleaseToken?: { nodeId: string, released: boolean } | null,")
rep('src/request/tier-loop.ts',
"    return { node: r.node };",
"    return { node: r.node, nodeReleaseToken: r.nodeReleaseToken ?? null };")

# Removed node limits are a configuration error visible on /health. A normal
# model request sees no valid route and therefore returns 404 without touching
# upstream; do not incorrectly require the request endpoint itself to return 503.
old="""  const res = await worker.fetch(messagesRequest({}), env, {});\n  assert.equal(res.status, 503, 'removed limits field makes runtime configuration invalid');\n  assert.equal(upstreamCalls.length, 0, 'invalid legacy config must never reach upstream');\n"""
new="""  const health = await worker.fetch(new Request('https://gateway.example.com/health', { headers: { authorization: `Bearer ${ACCESS_KEY}` } }), env, {});\n  assert.equal(health.status, 503, 'health must expose invalid runtime configuration');\n  const healthBody = await health.json();\n  assert.equal(healthBody.status, 'invalid');\n  assert.ok(healthBody.diagnostics.some((d) => d.includes('unknown field \\\"limits\\\"')));\n  const res = await worker.fetch(messagesRequest({}), env, {});\n  assert.equal(res.status, 404, 'invalid node is excluded, so the model route is unavailable');\n  assert.equal(upstreamCalls.length, 0, 'invalid legacy config must never reach upstream');\n"""
rep('tests/architecture-contract-test.mjs', old, new)

# Remove comments that still describe the retired per-node RPM/concurrency path.
s=rd('src/request/attempt/hedge.ts')
s=s.replace(
"  // selector below claims a concurrency slot + RPM reservation as a side\n  // effect of picking (acquireSlot inside pickCandidate), so a deadline that\n  // is already exhausted must bail out here — returning after the pick would\n  // strand those reservations on a twin that is never dispatched (the node\n  // then looks saturated, worst case at limits.concurrency=1). No remaining\n",
"  // selector below claims an execution lease as a side effect of picking, so\n  // a deadline that is already exhausted must bail out here — returning after\n  // the pick would strand that lease on a twin that is never dispatched. No remaining\n")
wr('src/request/attempt/hedge.ts',s)

print('pass4b applied')
