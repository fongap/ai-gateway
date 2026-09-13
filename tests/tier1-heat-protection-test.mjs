// SPDX-License-Identifier: MIT
// @ts-check
import assert from 'node:assert/strict';
import { pickTier1Candidate } from '../src/scheduler/tier1-scheduler.ts';
import {
  __resetTier1StateForTests, claimTier1Slot, makeTier1ReleaseToken, releaseTier1Slot,
  recordTier1ProviderModelRateLimit, recordTier1ProviderModelSuccess,
  tier1ProviderModelRateLimitCount, tier1ProviderModelHeatFactor,
  TIER1_PROVIDER_MODEL_429_WINDOW_MS,
} from '../src/reliability/tier1-state.ts';
import { tier1AffinityHeatFactor, tier1CanAcceptHedge, tier1ConcurrencyPressure } from '../src/reliability/tier1-heat.ts';

const now = 1_800_000_000_000;
const req = { model: 'Code-Max', protocol: 'openai', surface: 'chat_completions' };
const node = (id, overrides = {}) => ({ id, tier:'tier-1', provider:'nvidia', protocol:'openai', surfaces:['chat_completions'], baseUrl:'https://example.invalid/v1', credential:`secret-${id}`, priority:1, models:{'Code-Max':'upstream-code-max'}, ...overrides });
function releasePick(pick){ if(pick?.node&&pick?.releaseToken) releaseTier1Slot(pick.node.id,pick.releaseToken); }
async function test(name,fn){try{await fn();console.log(`ok - ${name}`)}catch(e){console.error(`not ok - ${name}`);console.error(e?.stack||e);process.exitCode=1}}

await test('cold accounts preserve affinity preference',()=>{__resetTier1StateForTests();const a=node('a'),b=node('b');const p=pickTier1Candidate([a,b],req,new Set(),{affinityAccountId:'a',now,rng:()=>0});assert.equal(p?.node?.id,'a');releasePick(p)});
await test('live in-flight heat weakens affinity and favors cooler peer',()=>{__resetTier1StateForTests();const a=node('a'),b=node('b');for(let i=0;i<3;i++)assert.equal(claimTier1Slot(a,now,req.model),true);assert.equal(tier1ConcurrencyPressure(a),0.75);assert.equal(tier1AffinityHeatFactor(a,0.85),0.9625);const p=pickTier1Candidate([a,b],req,new Set(),{affinityAccountId:'a',now,rng:()=>0,evaluateAffinity:true});assert.equal(p?.node?.id,'b');releasePick(p)});
await test('soft load never hard-blocks the only primary candidate',()=>{__resetTier1StateForTests();const a=node('a');for(let i=0;i<4;i++)assert.equal(claimTier1Slot(a,now,req.model),true);const p=pickTier1Candidate([a],req,new Set(),{now});assert.equal(p?.node?.id,'a');releasePick(p)});
await test('optional hedge is suppressed at 0.75 live pressure',()=>{__resetTier1StateForTests();const busy=node('busy');for(let i=0;i<3;i++)assert.equal(claimTier1Slot(busy,now,req.model),true);assert.equal(tier1CanAcceptHedge(busy),false)});
await test('optional hedge uses an idle peer',()=>{__resetTier1StateForTests();const primary=node('primary'),idle=node('idle');assert.equal(tier1CanAcceptHedge(idle),true);const p=pickTier1Candidate([primary,idle],req,new Set(),{excludeId:'primary',now,rng:()=>0});assert.equal(p?.node?.id,'idle');releasePick(p)});
await test('one or two independent 429 keys do not demote cohort',()=>{__resetTier1StateForTests();recordTier1ProviderModelRateLimit('nvidia','upstream-code-max','n1',now);recordTier1ProviderModelRateLimit('nvidia','upstream-code-max','n2',now+1);assert.equal(tier1ProviderModelRateLimitCount('nvidia','upstream-code-max',now+1),2);assert.equal(tier1ProviderModelHeatFactor('nvidia','upstream-code-max',now+1),1)});
await test('three/four independent 429 keys apply bounded soft heat',()=>{__resetTier1StateForTests();for(const [i,id] of ['n1','n2','n3'].entries())recordTier1ProviderModelRateLimit('nvidia','upstream-code-max',id,now+i);assert.equal(tier1ProviderModelHeatFactor('nvidia','upstream-code-max',now+3),1.15);recordTier1ProviderModelRateLimit('nvidia','upstream-code-max','n4',now+4);assert.equal(tier1ProviderModelHeatFactor('nvidia','upstream-code-max',now+4),1.35)});
await test('provider-model heat changes ranking but not eligibility',()=>{__resetTier1StateForTests();for(const id of ['n1','n2','n3'])recordTier1ProviderModelRateLimit('nvidia','upstream-code-max',id,now);const hot=node('n4'),cool=node('s1',{provider:'sensenova'});const p=pickTier1Candidate([hot,cool],req,new Set(),{now,rng:()=>0});assert.equal(p?.node?.id,'s1');releasePick(p);const only=pickTier1Candidate([hot],req,new Set(),{now});assert.equal(only?.node?.id,'n4');releasePick(only)});
await test('successes decay provider-model heat',()=>{__resetTier1StateForTests();for(const id of ['n1','n2','n3','n4'])recordTier1ProviderModelRateLimit('nvidia','upstream-code-max',id,now);recordTier1ProviderModelSuccess('nvidia','upstream-code-max','n5',now+1);assert.equal(tier1ProviderModelRateLimitCount('nvidia','upstream-code-max',now+1),3)});
await test('provider-model heat expires',()=>{__resetTier1StateForTests();for(const id of ['n1','n2','n3'])recordTier1ProviderModelRateLimit('nvidia','upstream-code-max',id,now);assert.equal(tier1ProviderModelHeatFactor('nvidia','upstream-code-max',now+TIER1_PROVIDER_MODEL_429_WINDOW_MS+1),1)});
