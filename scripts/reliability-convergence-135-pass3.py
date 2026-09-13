#!/usr/bin/env python3
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def rd(p): return (ROOT/p).read_text(encoding='utf-8')
def wr(p,s): (ROOT/p).write_text(s,encoding='utf-8')
def rep(p,a,b,n=1):
    s=rd(p); c=s.count(a)
    if c!=n: raise SystemExit(f'{p}: expected {n}, found {c}: {a[:120]!r}')
    wr(p,s.replace(a,b,n))
def rem(p,a,n=1): rep(p,a,'',n)

# Remove final RPM cleanup residue.
rem('src/reliability/node-state.ts', '''  // Prune RPM buckets that belong to a previous minute.\n  const minute = currentMinute(now);\n  for (const [id, bucket] of rpmBuckets) {\n    if (bucket.minute !== minute) rpmBuckets.delete(id);\n  }\n''')

# In-flight heat is intentionally soft. Test weakening, not a deterministic
# forced switch away from affinity at one exact pressure point.
s=rd('tests/tier1-heat-protection-test.mjs')
s=s.replace("import { tier1AffinityHeatFactor, tier1CanAcceptHedge, tier1ConcurrencyPressure } from '../src/reliability/tier1-heat.ts';",
            "import { tier1AffinityHeatFactor, tier1CanAcceptHedge, tier1ConcurrencyPressure, tier1SelectionHeatFactor } from '../src/reliability/tier1-heat.ts';")
old="await test('live in-flight heat weakens affinity and favors cooler peer',()=>{__resetTier1StateForTests();const a=node('a'),b=node('b');for(let i=0;i<3;i++)assert.equal(claimTier1Slot(a,now,req.model),true);assert.equal(tier1ConcurrencyPressure(a),0.75);assert.equal(tier1AffinityHeatFactor(a,0.85),0.9625);const p=pickTier1Candidate([a,b],req,new Set(),{affinityAccountId:'a',now,rng:()=>0,evaluateAffinity:true});assert.equal(p?.node?.id,'b');releasePick(p)});"
new="await test('live in-flight heat weakens affinity without becoming a hard gate',()=>{__resetTier1StateForTests();const a=node('a');for(let i=0;i<3;i++)assert.equal(claimTier1Slot(a,now,req.model),true);assert.equal(tier1ConcurrencyPressure(a),0.75);assert.equal(tier1AffinityHeatFactor(a,0.85),0.9625);assert.ok(tier1SelectionHeatFactor(a,0.85)>1);const p=pickTier1Candidate([a],req,new Set(),{affinityAccountId:'a',now,rng:()=>0,evaluateAffinity:true});assert.equal(p?.node?.id,'a');releasePick(p)});"
if old not in s: raise SystemExit('tier1 heat test drift')
wr('tests/tier1-heat-protection-test.mjs',s.replace(old,new,1))

# No legacy protocol/surface behavior remains.
s=rd('tests/protocol-matrix-test.mjs')
start=s.index("await test('legacy node config")
end=s.index("await test('explicit protocol=anthropic",start)
replacement='''await test('node config without protocol/surfaces is rejected instead of inferred', async () => {\n  resetMock();\n  const legacyNode = { id: 'legacy-01', provider: 'nvidia', base_url: 'https://legacy.example.com/v1', priority: 10, models: { max: 'up-model' } };\n  const env = makeEnv({ tier1: [legacyNode], secrets: { 'legacy-01': 'k' } });\n  const health = await worker.fetch(new Request('https://gateway.example.com/health', { headers: { authorization: `Bearer ${ACCESS_KEY}` } }), env, {});\n  assert.equal(health.status, 503);\n  const healthBody = await health.json();\n  assert.equal(healthBody.status, 'invalid');\n  assert.ok(healthBody.diagnostics.some((d) => d.includes('legacy-01') && d.includes('protocol is required')));\n  assert.deepEqual(upstreamCalls, []);\n});\n\n'''
s=s[:start]+replacement+s[end:]
wr('tests/protocol-matrix-test.mjs',s)

# Architecture contracts now encode the hard cut instead of deprecated behavior.
s=rd('tests/architecture-contract-test.mjs')
start=s.index('// =========================================================================\n// Contract 09')
end=s.index('// =========================================================================\n// Contract 10',start)
replacement='''// =========================================================================\n// Contract 09 — Removed Node Limits Fail Closed\n// =========================================================================\nawait test('Contract 09: removed node limits are rejected instead of influencing admission', async () => {\n  resetMock();\n  routeHandlers['an1.example.com'] = () => jsonUpstream(okMessage());\n  const env = makeEnv({\n    tier1: [anthropicNode('an1', { limits: { concurrency: 1, rpm: 60, rpm_mode: 'hard' } })],\n    secrets: { an1: 'k' },\n  });\n  const res = await worker.fetch(messagesRequest({}), env, {});\n  assert.equal(res.status, 503, 'removed limits field makes runtime configuration invalid');\n  assert.equal(upstreamCalls.length, 0, 'invalid legacy config must never reach upstream');\n});\n\n'''
s=s[:start]+replacement+s[end:]
old="  const res1 = await worker.fetch(messagesRequest({ model: 'Code-Max' }), env, {});\n  assert.ok(res1.status >= 400, 'Code-Max 404 from upstream -> gateway error (exhausted or client error)');\n  const res2 = await worker.fetch(messagesRequest({ model: 'Code-Pro' }), env, {});\n  assert.equal(res2.status, 200, 'Code-Pro must still be served after Code-Max 404 on same node');"
new="  const res1 = await worker.fetch(messagesRequest({ model: 'Code-Max' }), env, {});\n  assert.equal(res1.status, 200, 'Code-Max mapping 404 may fall back to compatible Code-Pro');\n  const body1 = await res1.json();\n  assert.equal(body1.model, 'Code-Max', 'transparent family fallback preserves requested model identity');\n  const res2 = await worker.fetch(messagesRequest({ model: 'Code-Pro' }), env, {});\n  assert.equal(res2.status, 200, 'Code-Pro must still be served after Code-Max 404 on same node');"
if old not in s: raise SystemExit('architecture contract 12 drift')
wr('tests/architecture-contract-test.mjs',s.replace(old,new,1))

# Dashboard fixtures must use the strict current node schema.
s=rd('tests/token-usage-test.mjs')
s=s.replace(", limits: { concurrency: 1 }", "")
wr('tests/token-usage-test.mjs',s)

print('pass3 applied')
