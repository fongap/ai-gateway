#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def rd(p): return (ROOT/p).read_text(encoding='utf-8')
def wr(p,s): (ROOT/p).write_text(s,encoding='utf-8')
def rep(p,a,b,n=1):
    s=rd(p); c=s.count(a)
    if c!=n: raise SystemExit(f'{p}: expected {n}, found {c}: {a[:100]!r}')
    wr(p,s.replace(a,b,n))
def rem(p,a,n=1): rep(p,a,'',n)

# ---- finish deleting node RPM/concurrency runtime semantics ----------------
rem('src/reliability/tier1-state.ts','  rpmBuckets.clear();\n')
rem('src/reliability/node-state.ts','  rpmBuckets.clear();\n')

# Tier1 score already receives in-flight pressure from tier1-heat; remove the
# old capacity-denominator load factor entirely.
s=rd('src/reliability/tier1-state.ts')
start=s.index('function loadFactor('); end=s.index('\nfunction failureFactor(',start)
s=s[:start]+s[end+1:]
s=s.replace('    * loadFactor(node)\n','')
s=s.replace("  if (node.limits.rpm && node.limits.rpmMode !== 'soft') {\n    const rpmWait = tier1RpmWaitMs(node.id, node.limits.rpm, now);\n    if (rpmWait > 0) return rpmWait;\n  }\n  if (account.inFlight >= node.limits.concurrency) return 1_000;\n",'')
s=s.replace('    if (account.inFlight >= node.limits.concurrency) return true;\n    if (node.limits.rpm && node.limits.rpmMode !== \'soft\'\n      && tier1RpmWaitMs(node.id, node.limits.rpm, now) > 0) return true;\n','')
wr('src/reliability/tier1-state.ts',s)

# Tier1 heat is now purely live in-flight + provider/model 429 evidence.
wr('src/reliability/tier1-heat.ts', '''// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Tier 1 soft heat protection. No guessed node capacity exists: live in-flight
// work weakens affinity/ranking and suppresses optional hedge twins, while real
// primary traffic always remains eligible unless reliability state blocks it.

import { tier1AccountInFlight } from './tier1-state.ts';
import type { RuntimeNode } from '../types/node.ts';

export const TIER1_INFLIGHT_MAX_FACTOR = 1.25;
export const TIER1_HEDGE_MAX_CONCURRENCY_PRESSURE = 0.75;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function tier1ConcurrencyPressure(node: RuntimeNode): number {
  const inFlight = tier1AccountInFlight(node.id);
  if (!Number.isFinite(inFlight) || inFlight <= 0) return 0;
  // 1 -> .50, 2 -> .67, 3 -> .75, 4 -> .80. Ranking only.
  return clamp01(inFlight / (inFlight + 1));
}

export function tier1HeatPressure(node: RuntimeNode): number {
  return tier1ConcurrencyPressure(node);
}

export function tier1InFlightFactor(node: RuntimeNode): number {
  const pressure = tier1ConcurrencyPressure(node);
  return 1 + (TIER1_INFLIGHT_MAX_FACTOR - 1) * pressure;
}

export function tier1AffinityHeatFactor(node: RuntimeNode, baseAffinityFactor: number): number {
  if (!Number.isFinite(baseAffinityFactor) || baseAffinityFactor >= 1) return 1;
  const pressure = tier1HeatPressure(node);
  return baseAffinityFactor + (1 - baseAffinityFactor) * pressure;
}

export function tier1SelectionHeatFactor(node: RuntimeNode, baseAffinityFactor: number): number {
  return tier1InFlightFactor(node) * tier1AffinityHeatFactor(node, baseAffinityFactor);
}

export function tier1CanAcceptHedge(node: RuntimeNode): boolean {
  return tier1ConcurrencyPressure(node) < TIER1_HEDGE_MAX_CONCURRENCY_PRESSURE;
}
''')

# Errors: no node RPM/deferred-capacity path remains. Cooldown/circuit recovery
# still contributes a real Retry-After.
s=rd('src/request/errors.ts')
s=s.replace("import { supportsRequest, isHardRpmExhausted, tierHasDeferredCapacity } from '../scheduler/scheduler.ts';","import { supportsRequest } from '../scheduler/scheduler.ts';")
s=s.replace("  // Distinguish WHY no node was available:\n  //   hard-RPM capacity deferred -> 503, so clients back off;\n  //   cooling / circuit open -> 429 + the smallest remaining cooldown;\n", "  // Distinguish WHY no node was available:\n  //   cooling / circuit / recovery gate -> 429 with the smallest real wait;\n")
old='''    } else {\n      const deferred = TIER_ORDER.some((t) =>\n        t === 1\n          ? tier1HasDeferredCapacity(tiers[t], reqDescriptor, state.attempted, now, knownModels_)\n          : tierHasDeferredCapacity(tiers[t], reqDescriptor, state.attempted, now, knownModels_));\n      if (deferred) {\n        status = 503;\n        message = 'All eligible nodes are at capacity. Retry shortly.';\n      } else {\n        status = 429;\n        message = 'All eligible nodes are temporarily unavailable (cooldown or circuit open).';\n      }\n      retryAfterSec = earliestBlockingRetryAfterSec(tiers, reqDescriptor, now, knownModels_);\n    }'''
new='''    } else {\n      status = 429;\n      message = 'All eligible nodes are temporarily unavailable (cooldown, recovery gate, or circuit open).';\n      retryAfterSec = earliestBlockingRetryAfterSec(tiers, reqDescriptor, now, knownModels_);\n    }'''
if old not in s: raise SystemExit('errors deferred block drift')
s=s.replace(old,new,1)
s=s.replace("      // A distributed rate-limiter deny (rate_limit_global) leaves no node\n      // cooldown — the node was never at fault. When that is what blocked\n      // everything, back the client off to the next fixed-window reset instead\n      // of omitting Retry-After entirely.\n      if (retryAfterSec === undefined && state.failureKinds?.rate_limit_global) {\n        retryAfterSec = distributedWindowRetryAfterSec(now);\n      }\n",'')
s=s.replace("// cooldown (429/auth/circuit) wins over the model-scoped cooldown (404). Hard\n// RPM exhaustion is bounded by the remaining minute window. Concurrency is a\n// soft ranking signal and never contributes a blocking wait.\n","// cooldown (429/auth/circuit) wins over the model-scoped cooldown (404). Live\n// in-flight load is ranking-only and never contributes a blocking wait.\n")
s=s.replace("  if (isHardRpmExhausted(node, now)) return Math.max(1, 60_000 - (now % 60_000));\n",'')
# remove obsolete distributed window helper
s=re.sub(r"\n// Seconds until the next fixed-window.*?\nfunction distributedWindowRetryAfterSec\(now: number = Date\.now\(\)\): number \{\n  return Math\.max\(1, Math\.ceil\(\(60_000 - \(now % 60_000\)\) / 1000\)\);\n\}\n",'\n',s,flags=re.S)
wr('src/request/errors.ts',s)

# ---- tests: strict current schema, no limits compatibility -----------------
rep('tests/github-deployment-config-test.mjs',
"        id: 'node-a', base_url: 'https://provider.example.com/v1',\n        models: { 'code-pro': 'upstream-code-pro' }, limits: { concurrency: 1, rpm_mode: 'hard' },",
"        id: 'node-a', protocol: 'openai', surfaces: ['chat_completions'], base_url: 'https://provider.example.com/v1',\n        models: { 'code-pro': 'upstream-code-pro' },")
# Every deployment fixture node must now declare transport explicitly.
s=rd('tests/github-deployment-config-test.mjs')
s=s.replace("{ id: 'node-a', base_url: 'https://provider.example.com/v1', models: { 'code-pro': 'up' } }","{ id: 'node-a', protocol: 'openai', surfaces: ['chat_completions'], base_url: 'https://provider.example.com/v1', models: { 'code-pro': 'up' } }")
s=s.replace('{\"id\":\"node-a\",\"base_url\":\"https://provider.example.com/v1\",\"models\":{\"code-pro\":\"up\"}、}', '{\"id\":\"node-a\",\"protocol\":\"openai\",\"surfaces\":[\"chat_completions\"],\"base_url\":\"https://provider.example.com/v1\",\"models\":{\"code-pro\":\"up\"}、}')
wr('tests/github-deployment-config-test.mjs',s)

# Replace obsolete gateway configuration contract block with strict-schema tests.
s=rd('tests/gateway-configuration-test.mjs')
start=s.index("test('unknown limits field")
end=s.index("test('invalid protocol value", start)
replacement='''test('removed limits field is rejected as unknown configuration', () => {\n  const cfg = loadGatewayConfig(makeEnv({ tier1: [node('b', { limits: { concurrency: 2 } })], secrets: { b: 'x' } }));\n  assert.equal(cfg.nodes.length, 0);\n  assert.ok(cfg.diagnostics.some((d) => d.includes('unknown field "limits"')), `expected strict-schema diagnostic, got ${cfg.diagnostics}`);\n});\n\ntest('invalid priority is rejected with a named diagnostic', () => {\n  const cfg = loadGatewayConfig(makeEnv({ tier1: [node('p', { priority: -1 })], secrets: { p: 'x' } }));\n  assert.equal(cfg.nodes.length, 0);\n  assert.ok(cfg.diagnostics.some((d) => d.includes('priority')));\n});\n\ntest('priority defaults to 100 with no node capacity fields', () => {\n  const cfg = loadGatewayConfig(makeEnv({ tier1: [node('ok')], secrets: { ok: 'x' } }));\n  assert.equal(cfg.status, 'ready');\n  assert.equal(cfg.nodes[0].priority, 100);\n  assert.equal('limits' in cfg.nodes[0], false);\n});\n\n// ---- protocol / surfaces schema --------------------------------------------\n\ntest('explicit protocol + surfaces build cleanly with no diagnostics', () => {\n  const cfg = loadGatewayConfig(makeEnv({ tier1: [node('p1')], secrets: { p1: 'x' } }));\n  assert.equal(cfg.status, 'ready');\n  assert.deepEqual(cfg.diagnostics, []);\n  assert.equal(cfg.nodes[0].protocol, 'openai');\n  assert.deepEqual(cfg.nodes[0].surfaces, ['chat_completions']);\n});\n\ntest('protocol and surfaces are required; implicit legacy defaults are rejected', () => {\n  const missingBoth = { id: 'old-01', provider: 'nvidia', base_url: 'https://old.example.com/v1', models: {} };\n  const a = loadGatewayConfig(makeEnv({ tier1: [missingBoth], secrets: { 'old-01': 'x' } }));\n  assert.equal(a.status, 'invalid');\n  assert.ok(a.diagnostics.some((d) => d.includes('protocol is required')));\n\n  const missingSurface = { id: 'an-01', provider: 'anthropic', protocol: 'anthropic', base_url: 'https://an.example.com', models: {} };\n  const b = loadGatewayConfig(makeEnv({ tier1: [missingSurface], secrets: { 'an-01': 'x' } }));\n  assert.equal(b.status, 'invalid');\n  assert.ok(b.diagnostics.some((d) => d.includes('surfaces is required')));\n});\n\n'''
s=s[:start]+replacement+s[end:]
wr('tests/gateway-configuration-test.mjs',s)

# request-reliability: remove RPM admission tests and old distributed classifier;
# update the non-JSON contract to the new reliability behavior.
s=rd('tests/request-reliability-test.mjs')
s=s.replace('  rollbackRpmBucket, rpmUsage,\n','')
s=s.replace('classifyClientAbort, classifyPreDispatchRateLimit, classifyPreDispatchInvalidBaseUrl','classifyClientAbort, classifyPreDispatchInvalidBaseUrl')
start=s.index("await test('rollbackRpmBucket returns")
end=s.index('// ---- Per-attempt header-wait budget split',start)
s=s[:start]+s[end:]
s=s.replace("    limits: { concurrency: 1, rpm: 0, rpmMode: 'hard' },\n",'')
start=s.index("await test('classifyPreDispatchRateLimit")
end=s.index("await test('classifyPreDispatchInvalidBaseUrl",start)
s=s[:start]+s[end:]
s=s.replace("await test('classifyNonJsonBody: neutral, NOT counted (upstream WAS contacted, no circuit penalty)', async () => {\n  const c = classifyNonJsonBody();\n  assert.equal(c.kind, KIND.NON_JSON_BODY);\n  assert.equal(c.action, 'neutral');\n  assert.equal(c.cooldownMs, 0);\n  assert.equal(c.counted, false);\n});",
"await test('classifyNonJsonBody: rotate, counted, short cooldown', async () => {\n  const c = classifyNonJsonBody();\n  assert.equal(c.kind, KIND.NON_JSON_BODY);\n  assert.equal(c.action, 'rotate');\n  assert.equal(c.cooldownMs, 5_000);\n  assert.equal(c.counted, true);\n});")
wr('tests/request-reliability-test.mjs',s)

# Tier1 heat test: retain in-flight and provider/model heat, remove guessed RPM.
wr('tests/tier1-heat-protection-test.mjs', '''// SPDX-License-Identifier: MIT\n// @ts-check\nimport assert from 'node:assert/strict';\nimport { pickTier1Candidate } from '../src/scheduler/tier1-scheduler.ts';\nimport {\n  __resetTier1StateForTests, claimTier1Slot, makeTier1ReleaseToken, releaseTier1Slot,\n  recordTier1ProviderModelRateLimit, recordTier1ProviderModelSuccess,\n  tier1ProviderModelRateLimitCount, tier1ProviderModelHeatFactor,\n  TIER1_PROVIDER_MODEL_429_WINDOW_MS,\n} from '../src/reliability/tier1-state.ts';\nimport { tier1AffinityHeatFactor, tier1CanAcceptHedge, tier1ConcurrencyPressure } from '../src/reliability/tier1-heat.ts';\n\nconst now = 1_800_000_000_000;\nconst req = { model: 'Code-Max', protocol: 'openai', surface: 'chat_completions' };\nconst node = (id, overrides = {}) => ({ id, tier:'tier-1', provider:'nvidia', protocol:'openai', surfaces:['chat_completions'], baseUrl:'https://example.invalid/v1', credential:`secret-${id}`, priority:1, models:{'Code-Max':'upstream-code-max'}, ...overrides });\nfunction releasePick(pick){ if(pick?.node&&pick?.releaseToken) releaseTier1Slot(pick.node.id,pick.releaseToken); }\nasync function test(name,fn){try{await fn();console.log(`ok - ${name}`)}catch(e){console.error(`not ok - ${name}`);console.error(e?.stack||e);process.exitCode=1}}\n\nawait test('cold accounts preserve affinity preference',()=>{__resetTier1StateForTests();const a=node('a'),b=node('b');const p=pickTier1Candidate([a,b],req,new Set(),{affinityAccountId:'a',now,rng:()=>0});assert.equal(p?.node?.id,'a');releasePick(p)});\nawait test('live in-flight heat weakens affinity and favors cooler peer',()=>{__resetTier1StateForTests();const a=node('a'),b=node('b');for(let i=0;i<3;i++)assert.equal(claimTier1Slot(a,now,req.model),true);assert.equal(tier1ConcurrencyPressure(a),0.75);assert.equal(tier1AffinityHeatFactor(a,0.85),0.9625);const p=pickTier1Candidate([a,b],req,new Set(),{affinityAccountId:'a',now,rng:()=>0,evaluateAffinity:true});assert.equal(p?.node?.id,'b');releasePick(p)});\nawait test('soft load never hard-blocks the only primary candidate',()=>{__resetTier1StateForTests();const a=node('a');for(let i=0;i<4;i++)assert.equal(claimTier1Slot(a,now,req.model),true);const p=pickTier1Candidate([a],req,new Set(),{now});assert.equal(p?.node?.id,'a');releasePick(p)});\nawait test('optional hedge is suppressed at 0.75 live pressure',()=>{__resetTier1StateForTests();const busy=node('busy');for(let i=0;i<3;i++)assert.equal(claimTier1Slot(busy,now,req.model),true);assert.equal(tier1CanAcceptHedge(busy),false)});\nawait test('optional hedge uses an idle peer',()=>{__resetTier1StateForTests();const primary=node('primary'),idle=node('idle');assert.equal(tier1CanAcceptHedge(idle),true);const p=pickTier1Candidate([primary,idle],req,new Set(),{excludeId:'primary',now,rng:()=>0});assert.equal(p?.node?.id,'idle');releasePick(p)});\nawait test('one or two independent 429 keys do not demote cohort',()=>{__resetTier1StateForTests();recordTier1ProviderModelRateLimit('nvidia','upstream-code-max','n1',now);recordTier1ProviderModelRateLimit('nvidia','upstream-code-max','n2',now+1);assert.equal(tier1ProviderModelRateLimitCount('nvidia','upstream-code-max',now+1),2);assert.equal(tier1ProviderModelHeatFactor('nvidia','upstream-code-max',now+1),1)});\nawait test('three/four independent 429 keys apply bounded soft heat',()=>{__resetTier1StateForTests();for(const [i,id] of ['n1','n2','n3'].entries())recordTier1ProviderModelRateLimit('nvidia','upstream-code-max',id,now+i);assert.equal(tier1ProviderModelHeatFactor('nvidia','upstream-code-max',now+3),1.15);recordTier1ProviderModelRateLimit('nvidia','upstream-code-max','n4',now+4);assert.equal(tier1ProviderModelHeatFactor('nvidia','upstream-code-max',now+4),1.35)});\nawait test('provider-model heat changes ranking but not eligibility',()=>{__resetTier1StateForTests();for(const id of ['n1','n2','n3'])recordTier1ProviderModelRateLimit('nvidia','upstream-code-max',id,now);const hot=node('n4'),cool=node('s1',{provider:'sensenova'});const p=pickTier1Candidate([hot,cool],req,new Set(),{now,rng:()=>0});assert.equal(p?.node?.id,'s1');releasePick(p);const only=pickTier1Candidate([hot],req,new Set(),{now});assert.equal(only?.node?.id,'n4');releasePick(only)});\nawait test('successes decay provider-model heat',()=>{__resetTier1StateForTests();for(const id of ['n1','n2','n3','n4'])recordTier1ProviderModelRateLimit('nvidia','upstream-code-max',id,now);recordTier1ProviderModelSuccess('nvidia','upstream-code-max','n5',now+1);assert.equal(tier1ProviderModelRateLimitCount('nvidia','upstream-code-max',now+1),3)});\nawait test('provider-model heat expires',()=>{__resetTier1StateForTests();for(const id of ['n1','n2','n3'])recordTier1ProviderModelRateLimit('nvidia','upstream-code-max',id,now);assert.equal(tier1ProviderModelHeatFactor('nvidia','upstream-code-max',now+TIER1_PROVIDER_MODEL_429_WINDOW_MS+1),1)});\n''')

# Strict-schema fixture modernization across tests: RuntimeNode literals no longer
# carry `limits`. JSON config fixtures that intentionally test strict rejection
# are handled above and are not blanket-rewritten.
for p in (ROOT/'tests').glob('*.mjs'):
    if p.name in {'gateway-configuration-test.mjs','request-reliability-test.mjs','tier1-heat-protection-test.mjs'}: continue
    s=p.read_text(encoding='utf-8')
    # Runtime-node test literals: remove simple one-line limits objects.
    s=re.sub(r"\n\s*limits:\s*\{\s*concurrency:\s*[^}\n]+\},?",'',s)
    p.write_text(s,encoding='utf-8')

print('pass2 applied')
