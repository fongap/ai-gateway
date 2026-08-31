#!/usr/bin/env node
// Gateway configuration tests: shard index parsing, fail-fast Node schema,
// wildcard-vs-invalid `models` semantics, and the Model Registry.
import assert from 'node:assert/strict';
import {
  loadGatewayConfig, collectShards, TIER_SHARD_PATTERN, SECRET_SHARD_PATTERN,
} from '../src/config/nodes.js';
import {
  loadModelRegistry, modelRegistryEntry, servesModel, isWildcardNode,
} from '../src/config/registry.js';
import { getModelsConfigDiagnostics } from '../src/config/models.js';
import { getPoliciesConfigDiagnostics, loadPoliciesConfig } from '../src/config/policies.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e && e.stack || e);
    process.exitCode = 1;
  }
}

const node = (id, extra = {}) => ({
  id,
  provider: 'mock',
  protocol: 'openai',
  surfaces: ['chat_completions'],
  base_url: `https://${id}.example.com/v1`,
  models: { 'general-air': 'up-model' },
  ...extra,
});

function makeEnv({ tier1, secrets, extraEnv } = {}) {
  return {
    GATEWAY_ACCESS_KEY: 'k',
    ...(tier1 ? { TIER1_NODES_CONFIG_01: JSON.stringify(tier1) } : {}),
    ...(secrets ? { NODE_SECRETS_01: JSON.stringify(secrets) } : {}),
    ...extraEnv,
  };
}

// ---- Shard index capture groups -------------------------------------------

test('collectShards parses the correct index group per shard kind', () => {
  const secretShards = collectShards(
    { NODE_SECRETS_01: '{}', NODE_SECRETS_09: '{}', NODE_SECRETS_12: '{}' },
    SECRET_SHARD_PATTERN, 'NODE_SECRETS_', 'NODE_SECRETS_01', 1, [],
  );
  assert.deepEqual(secretShards.map((s) => s.index).sort((a, b) => a - b), [1, 9, 12]);
  assert.ok(secretShards.every((s) => Number.isInteger(s.index)), 'secret index must be a number, never NaN');

  const tierShards = collectShards(
    { TIER2_NODES_CONFIG_03: '[]' },
    TIER_SHARD_PATTERN, 'TIER2_NODES_CONFIG_', 'TIER2_NODES_CONFIG_01', 2, [],
  );
  assert.equal(tierShards[0].tierNumber, 2);
  assert.equal(tierShards[0].index, 3);
});

test('malformed shard name is flagged instead of silently ignored', () => {
  const diags = [];
  collectShards(
    { TIER1_NODES_CONFIG_01: '[]', TIER1_NODES_CONFIG_XX: '[]' },
    TIER_SHARD_PATTERN, 'TIER1_NODES_CONFIG_', 'TIER1_NODES_CONFIG_01', 2, diags,
  );
  assert.equal(diags.length, 1);
  assert.match(diags[0], /malformed shard name/);
});

// ---- models: wildcard vs invalid ------------------------------------------

test('models missing or explicit {} is a wildcard', () => {
  const missing = loadGatewayConfig(makeEnv({ tier1: [node('a', { models: undefined })], secrets: { a: 'x' } }));
  assert.deepEqual(missing.nodes[0].models, {});
  const empty = loadGatewayConfig(makeEnv({ tier1: [node('a', { models: {} })], secrets: { a: 'x' } }));
  assert.deepEqual(empty.nodes[0].models, {});
  assert.equal(empty.status, 'ready');
});

test('filled-but-invalid models map is a config error, NOT a wildcard', () => {
  const bad = loadGatewayConfig(makeEnv({ tier1: [node('bad', { models: { 'general-air': 123 } })], secrets: { bad: 'x' } }));
  assert.equal(bad.nodes.length, 0);
  assert.ok(bad.diagnostics.some((d) => d.includes('models')), `expected a models diagnostic, got ${bad.diagnostics}`);
});

test('scalar / boolean models value is rejected, never emptied into wildcard', () => {
  for (const value of ['deepseek', 5, true]) {
    const cfg = loadGatewayConfig(makeEnv({ tier1: [node('s', { models: value })], secrets: { s: 'x' } }));
    assert.equal(cfg.nodes.length, 0, `models=${JSON.stringify(value)} must not become a wildcard`);
    assert.ok(cfg.diagnostics.some((d) => d.includes('models')), 'must produce a models diagnostic');
  }
});

// ---- fail-fast Node schema -------------------------------------------------

test('unknown top-level field (prioirty typo) is rejected', () => {
  const cfg = loadGatewayConfig(makeEnv({ tier1: [node('b', { prioirty: 5 })], secrets: { b: 'x' } }));
  assert.equal(cfg.nodes.length, 0);
  assert.ok(cfg.diagnostics.some((d) => d.includes('prioirty')), `expected unknown-field diagnostic, got ${cfg.diagnostics}`);
});

test('unknown limits field (concurency typo) is rejected', () => {
  const cfg = loadGatewayConfig(makeEnv({ tier1: [node('b', { limits: { concurency: 2 } })], secrets: { b: 'x' } }));
  assert.equal(cfg.nodes.length, 0);
  assert.ok(cfg.diagnostics.some((d) => d.includes('concurency')), `expected limits diagnostic, got ${cfg.diagnostics}`);
});

test('invalid priority / concurrency / rpm are rejected with a named diagnostic', () => {
  const priority = loadGatewayConfig(makeEnv({ tier1: [node('p', { priority: -1 })], secrets: { p: 'x' } }));
  assert.equal(priority.nodes.length, 0);
  assert.ok(priority.diagnostics.some((d) => d.includes('priority')));
  const concurrency = loadGatewayConfig(makeEnv({ tier1: [node('c', { limits: { concurrency: 0 } })], secrets: { c: 'x' } }));
  assert.equal(concurrency.nodes.length, 0);
  assert.ok(concurrency.diagnostics.some((d) => d.includes('concurrency')));
  const rpm = loadGatewayConfig(makeEnv({ tier1: [node('r', { limits: { rpm: 'abc' } })], secrets: { r: 'x' } }));
  assert.equal(rpm.nodes.length, 0);
  assert.ok(rpm.diagnostics.some((d) => d.includes('rpm')));
});

test('rpm_mode defaults to hard when rpm is set; soft is opt-in; invalid rejected', () => {
  const def = loadGatewayConfig(makeEnv({ tier1: [node('d', { limits: { rpm: 10 } })], secrets: { d: 'x' } }));
  assert.equal(def.nodes[0].limits.rpmMode, 'hard');
  const soft = loadGatewayConfig(makeEnv({ tier1: [node('s', { limits: { rpm: 10, rpm_mode: 'soft' } })], secrets: { s: 'x' } }));
  assert.equal(soft.nodes[0].limits.rpmMode, 'soft');
  const bad = loadGatewayConfig(makeEnv({ tier1: [node('b', { limits: { rpm: 10, rpm_mode: 'unlimited' } })], secrets: { b: 'x' } }));
  assert.equal(bad.nodes.length, 0);
  assert.ok(bad.diagnostics.some((d) => d.includes('rpm_mode')));
});

test('valid priority defaults to 100 and concurrency to 2', () => {
  const cfg = loadGatewayConfig(makeEnv({ tier1: [node('ok')], secrets: { ok: 'x' } }));
  assert.equal(cfg.status, 'ready');
  assert.equal(cfg.nodes[0].priority, 100);
  assert.equal(cfg.nodes[0].limits.concurrency, 2);
});

// ---- protocol / surfaces schema --------------------------------------------

test('explicit protocol + surfaces build cleanly with no diagnostics', () => {
  const cfg = loadGatewayConfig(makeEnv({ tier1: [node('p1')], secrets: { p1: 'x' } }));
  assert.equal(cfg.status, 'ready');
  assert.deepEqual(cfg.diagnostics, []);
  assert.equal(cfg.nodes[0].protocol, 'openai');
  assert.deepEqual(cfg.nodes[0].surfaces, ['chat_completions']);
});

test('legacy nodes without protocol/surfaces still build (deprecated defaults, NOT invalid)', () => {
  const legacy = { id: 'old-01', provider: 'nvidia', base_url: 'https://old.example.com/v1', models: {} };
  const cfg = loadGatewayConfig(makeEnv({ tier1: [legacy], secrets: { 'old-01': 'x' } }));
  assert.equal(cfg.status, 'ready', 'a legacy node must NOT invalidate the gateway');
  assert.equal(cfg.ready, true);
  assert.equal(cfg.nodes.length, 1);
  assert.equal(cfg.nodes[0].protocol, 'openai', 'missing protocol defaults to openai');
  assert.deepEqual(cfg.nodes[0].surfaces, ['chat_completions'], 'missing surfaces defaults to chat_completions');
  assert.ok(cfg.diagnostics.some((d) => d.includes('old-01') && d.includes('protocol is implicit and defaults to "openai"')),
    `expected a protocol deprecation diagnostic, got ${cfg.diagnostics}`);
  assert.ok(cfg.diagnostics.some((d) => d.includes('old-01') && d.includes('surfaces is implicit and defaults to ["chat_completions"]')),
    `expected a surfaces deprecation diagnostic, got ${cfg.diagnostics}`);
});

test('anthropic protocol nodes default to the messages surface', () => {
  const legacy = { id: 'an-01', provider: 'anthropic', protocol: 'anthropic', base_url: 'https://an.example.com', models: {} };
  const cfg = loadGatewayConfig(makeEnv({ tier1: [legacy], secrets: { 'an-01': 'x' } }));
  assert.equal(cfg.status, 'ready');
  assert.deepEqual(cfg.nodes[0].surfaces, ['messages']);
});

test('invalid protocol value is rejected with a named diagnostic', () => {
  for (const bad of ['gemini', 'grpc', 'OPENAI-X', '']) {
    const cfg = loadGatewayConfig(makeEnv({ tier1: [node('bp', { protocol: bad })], secrets: { bp: 'x' } }));
    assert.equal(cfg.nodes.length, 0, `protocol=${JSON.stringify(bad)} must be rejected`);
    assert.ok(cfg.diagnostics.some((d) => d.includes('protocol must be "openai" or "anthropic"')));
  }
});

test('invalid surfaces entries are rejected with a named diagnostic', () => {
  const empty = loadGatewayConfig(makeEnv({ tier1: [node('se', { surfaces: [] })], secrets: { se: 'x' } }));
  assert.equal(empty.nodes.length, 0);
  assert.ok(empty.diagnostics.some((d) => d.includes('surfaces must be a non-empty array')));
  const wrongProto = loadGatewayConfig(makeEnv({ tier1: [node('sw', { protocol: 'anthropic', surfaces: ['chat_completions'] })], secrets: { sw: 'x' } }));
  assert.equal(wrongProto.nodes.length, 0, 'an anthropic node cannot declare the chat_completions surface');
  assert.ok(wrongProto.diagnostics.some((d) => d.includes('not valid for protocol "anthropic"')));
  const unknown = loadGatewayConfig(makeEnv({ tier1: [node('su', { surfaces: ['gemini'] })], secrets: { su: 'x' } }));
  assert.equal(unknown.nodes.length, 0);
  assert.ok(unknown.diagnostics.some((d) => d.includes('not valid for protocol "openai"')));
});

test('openai nodes may declare both chat_completions and responses surfaces', () => {
  const cfg = loadGatewayConfig(makeEnv({ tier1: [node('multi', { surfaces: ['responses', 'chat_completions'] })], secrets: { multi: 'x' } }));
  assert.equal(cfg.status, 'ready');
  assert.deepEqual(cfg.nodes[0].surfaces, ['responses', 'chat_completions']);
});

// ---- Model Registry --------------------------------------------------------

test('registry builds capability + policy from MODELS_CONFIG and fills conservative defaults', () => {
  const env = makeEnv({
    tier1: [node('a', { models: {} })],
    secrets: { a: 'x' },
    extraEnv: {
      MODELS_CONFIG: JSON.stringify({
        'code-pro': { policy: 'fast', capabilities: { vision: true }, reasoning_efforts: ['high'] },
      }),
    },
  });
  const reg = loadModelRegistry(env);
  assert.equal(reg['code-pro'].policy, 'fast');
  assert.equal(reg['code-pro'].capabilities.vision, true);
  assert.deepEqual(reg['code-pro'].reasoning_efforts, ['high']);
  // Under-report, never over-report: undeclared models claim nothing beyond
  // streaming until MODELS_CONFIG explicitly declares the capability.
  const def = modelRegistryEntry(env, 'unknown-model');
  assert.equal(def.capabilities.tools, false, 'undeclared models must not promise tools');
  assert.equal(def.capabilities.reasoning, false, 'undeclared models must not promise reasoning');
  assert.equal(def.capabilities.vision, false);
  assert.deepEqual(def.reasoning_efforts, [], 'no reasoning efforts without a declaration');
});

test('servesModel treats empty models as wildcard, mapped as explicit', () => {
  assert.equal(isWildcardNode(node('w', { models: {} })), true);
  assert.equal(servesModel(node('w', { models: {} }), 'anything'), true);
  assert.equal(servesModel(node('m', { models: { only: 'x' } }), 'only'), true);
  assert.equal(servesModel(node('m', { models: { only: 'x' } }), 'other'), false);
});

// ---- Strict MODELS_CONFIG / POLICIES_CONFIG diagnostics --------------------
// Auxiliary configs must be as fail-fast as the node config: malformed JSON and
// field-level errors surface as diagnostics (visible via /health) + degraded
// status instead of silently falling back to defaults.

test('malformed MODELS_CONFIG is FATAL: invalid config refuses service', () => {
  const cfg = loadGatewayConfig(makeEnv({
    tier1: [node('m1', { models: { 'general-air': 'up' } })],
    secrets: { m1: 'k' },
    extraEnv: { MODELS_CONFIG: '{not json' },
  }));
  assert.equal(cfg.status, 'invalid', 'a malformed MODELS_CONFIG must be fatal, not degraded');
  assert.equal(cfg.ready, false, 'a malformed MODELS_CONFIG must refuse service');
  assert.ok(cfg.diagnostics.some((d) => d.includes('MODELS_CONFIG')), `expected MODELS_CONFIG diagnostic, got ${cfg.diagnostics}`);
});

test('MODELS_CONFIG rejects unknown capabilities and non-boolean values', () => {
  const diags = getModelsConfigDiagnostics(makeEnv({ extraEnv: {
    MODELS_CONFIG: JSON.stringify({
      'm': { capabilities: { tools: true, visionz: true, reasoning: 'yes' } },
    }),
  } }));
  assert.ok(diags.some((d) => d.includes('capabilities.visionz')), 'unknown capability key must be flagged');
  assert.ok(diags.some((d) => d.includes('capabilities.reasoning')), 'non-boolean capability must be flagged');
});

test('malformed POLICIES_CONFIG is FATAL: invalid config refuses service', () => {
  const cfg = loadGatewayConfig(makeEnv({
    tier1: [node('p1')],
    secrets: { p1: 'k' },
    extraEnv: { POLICIES_CONFIG: '{bad' },
  }));
  assert.equal(cfg.status, 'invalid', 'a malformed POLICIES_CONFIG must be fatal, not degraded');
  assert.equal(cfg.ready, false, 'a malformed POLICIES_CONFIG must refuse service');
  assert.ok(cfg.diagnostics.some((d) => d.includes('POLICIES_CONFIG')), `expected POLICIES_CONFIG diagnostic, got ${cfg.diagnostics}`);
});

// ---- Single-error cases: each failure mode isolated with exclusive text ----
// Every case feeds ONE bad value so `diags.length === 1` proves the diagnostic
// is caused by exactly that field; assertions match the validator's own phrase
// instead of a generic substring (which the `(allowed: ...)` hints also contain).

const policyDiags = (policies) => getPoliciesConfigDiagnostics(makeEnv({
  extraEnv: { POLICIES_CONFIG: JSON.stringify(policies) },
}));

const modelDiags = (models) => getModelsConfigDiagnostics(makeEnv({
  extraEnv: { MODELS_CONFIG: JSON.stringify(models) },
}));

const MAX_ATTEMPTS_TEXT = /max_attempts must be an integer between 1 and 8/;
const TIER_ATTEMPTS_TEXT = /tier_attempts\.tier1 must be an integer between 0 and 8/;

test('POLICIES_CONFIG rejects a non-string max_attempts', () => {
  const diags = policyDiags({ 'p-abc': { max_attempts: 'abc' } });
  assert.equal(diags.length, 1, `one isolated diagnostic expected, got ${JSON.stringify(diags)}`);
  assert.match(diags[0], /"p-abc": max_attempts must be an integer between 1 and 8/);
});

test('POLICIES_CONFIG rejects a below-range max_attempts', () => {
  const diags = policyDiags({ 'p-low': { max_attempts: -1 } });
  assert.equal(diags.length, 1, `one isolated diagnostic expected, got ${JSON.stringify(diags)}`);
  assert.match(diags[0], MAX_ATTEMPTS_TEXT);
});

test('POLICIES_CONFIG rejects an above-range max_attempts', () => {
  const diags = policyDiags({ 'p-high': { max_attempts: 9 } });
  assert.equal(diags.length, 1, `one isolated diagnostic expected, got ${JSON.stringify(diags)}`);
  assert.match(diags[0], MAX_ATTEMPTS_TEXT);
});

test('POLICIES_CONFIG rejects a non-integer max_attempts', () => {
  const diags = policyDiags({ 'p-frac': { max_attempts: 1.5 } });
  assert.equal(diags.length, 1, `one isolated diagnostic expected, got ${JSON.stringify(diags)}`);
  assert.match(diags[0], MAX_ATTEMPTS_TEXT);
});

test('POLICIES_CONFIG rejects an explicit null max_attempts', () => {
  const diags = policyDiags({ 'p-null': { max_attempts: null } });
  assert.equal(diags.length, 1, `one isolated diagnostic expected, got ${JSON.stringify(diags)}`);
  assert.match(diags[0], MAX_ATTEMPTS_TEXT);
});

test('POLICIES_CONFIG rejects a non-integer tier_attempts value', () => {
  const diags = policyDiags({ 't-frac': { tier_attempts: { tier1: 1.5 } } });
  assert.equal(diags.length, 1, `one isolated diagnostic expected, got ${JSON.stringify(diags)}`);
  assert.match(diags[0], /"t-frac" tier_attempts\.tier1 must be an integer between 0 and 8/);
});

test('POLICIES_CONFIG rejects an above-range tier_attempts value', () => {
  const diags = policyDiags({ 't-high': { tier_attempts: { tier1: 9 } } });
  assert.equal(diags.length, 1, `one isolated diagnostic expected, got ${JSON.stringify(diags)}`);
  assert.match(diags[0], TIER_ATTEMPTS_TEXT);
});

test('POLICIES_CONFIG rejects a negative tier_attempts value', () => {
  const diags = policyDiags({ 't-neg': { tier_attempts: { tier1: -1 } } });
  assert.equal(diags.length, 1, `one isolated diagnostic expected, got ${JSON.stringify(diags)}`);
  assert.match(diags[0], TIER_ATTEMPTS_TEXT);
});

test('POLICIES_CONFIG rejects an unknown tier_attempts key', () => {
  const diags = policyDiags({ 't-key': { tier_attempts: { tier9: 2 } } });
  assert.equal(diags.length, 1, `one isolated diagnostic expected, got ${JSON.stringify(diags)}`);
  assert.match(diags[0], /tier_attempts\.tier9 is not a valid tier/);
});

test('POLICIES_CONFIG rejects unknown policy fields', () => {
  const diags = policyDiags({ 'p-unknown': { nope: 1 } });
  assert.equal(diags.length, 1, `one isolated diagnostic expected, got ${JSON.stringify(diags)}`);
  assert.match(diags[0], /has unknown field "nope"/);
});

// ---- Hedge policy parsing -----------------------------------------------

test('POLICIES_CONFIG parses a valid hedge policy', () => {
  const policies = loadPoliciesConfig(makeEnv({
    extraEnv: { POLICIES_CONFIG: JSON.stringify({ 'hp': { max_attempts: 5, hedge: { enabled: true, delay_ms: 4000, tiers: ['tier1'] } } }) },
  }));
  assert.equal(policies.hp.hedge.enabled, true);
  assert.equal(policies.hp.hedge.delayMs, 4000);
  assert.deepEqual(policies.hp.hedge.tiers, ['tier1']);
});

test('POLICIES_CONFIG hedge null/absent returns null (legacy behavior)', () => {
  const policies = loadPoliciesConfig(makeEnv({
    extraEnv: { POLICIES_CONFIG: JSON.stringify({ 'hp': { max_attempts: 5 } }) },
  }));
  assert.equal(policies.hp.hedge, null, 'absent hedge field = null = legacy global hedge');
});

test('POLICIES_CONFIG hedge.enabled=false is accepted', () => {
  const policies = loadPoliciesConfig(makeEnv({
    extraEnv: { POLICIES_CONFIG: JSON.stringify({ 'hp': { max_attempts: 5, hedge: { enabled: false } } }) },
  }));
  assert.equal(policies.hp.hedge.enabled, false);
});

test('POLICIES_CONFIG rejects a non-boolean hedge.enabled', () => {
  const diags = policyDiags({ 'hp': { hedge: { enabled: 'yes' } } });
  assert.equal(diags.length, 1);
  assert.match(diags[0], /hedge\.enabled must be a boolean/);
});

test('POLICIES_CONFIG rejects a non-integer hedge.delay_ms', () => {
  const diags = policyDiags({ 'hp': { hedge: { delay_ms: 1.5 } } });
  assert.equal(diags.length, 1);
  assert.match(diags[0], /hedge\.delay_ms must be a non-negative integer/);
});

test('POLICIES_CONFIG rejects a negative hedge.delay_ms', () => {
  const diags = policyDiags({ 'hp': { hedge: { delay_ms: -1 } } });
  assert.equal(diags.length, 1);
  assert.match(diags[0], /hedge\.delay_ms must be a non-negative integer/);
});

test('POLICIES_CONFIG rejects invalid hedge.tiers values', () => {
  const diags = policyDiags({ 'hp': { hedge: { tiers: ['tier9'] } } });
  assert.equal(diags.length, 1);
  assert.match(diags[0], /hedge\.tiers must be an array of/);
});

test('MODELS_CONFIG rejects a non-string policy', () => {
  const diags = modelDiags({ 'm-num': { policy: 123 } });
  assert.equal(diags.length, 1, `one isolated diagnostic expected, got ${JSON.stringify(diags)}`);
  assert.match(diags[0], /model "m-num": policy must be a non-empty string/);
});

test('MODELS_CONFIG rejects empty and whitespace-only policy', () => {
  for (const bad of ['', '   ']) {
    const diags = modelDiags({ 'm-empty': { policy: bad } });
    assert.equal(diags.length, 1,
      `policy=${JSON.stringify(bad)}: one isolated diagnostic expected, got ${JSON.stringify(diags)}`);
    assert.match(diags[0], /model "m-empty": policy must be a non-empty string/);
  }
});

test('valid boundary attempts survive strict validation and defaults stay intact', () => {
  const diags = policyDiags({
    lo: { max_attempts: 1, tier_attempts: { tier1: 0 } },
    hi: { max_attempts: 8, tier_attempts: { tier3: 8 } },
  });
  assert.deepEqual(diags, [], 'boundary values 1/8 and disabling 0 must not error');
  const pol = loadPoliciesConfig(makeEnv({ extraEnv: {
    POLICIES_CONFIG: JSON.stringify({ loose: {} }),
  } }));
  assert.equal(pol.loose.maxAttempts, 5, 'an omitted max_attempts keeps the default of 5');
  assert.equal(pol.loose.tierAttempts, null, 'an omitted tier_attempts stays null');
});

test('invalid max_attempts is FATAL end-to-end: status invalid, ready false', () => {
  const cfg = loadGatewayConfig(makeEnv({
    tier1: [node('f1')],
    secrets: { f1: 'k' },
    extraEnv: { POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 0 } }) },
  }));
  assert.equal(cfg.status, 'invalid', 'an invalid max_attempts must be fatal, not degraded');
  assert.equal(cfg.ready, false, 'an invalid max_attempts must refuse service');
  assert.ok(cfg.diagnostics.some((d) => d.includes('max_attempts must be an integer')),
    `expected the named max_attempts diagnostic, got ${cfg.diagnostics}`);
});

test('a model referencing an undefined policy is a FATAL config diagnostic', () => {
  const env = makeEnv({
    tier1: [node('x1')],
    secrets: { x1: 'k' },
    extraEnv: {
      MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'missing-policy' } }),
      POLICIES_CONFIG: JSON.stringify({ default: { max_attempts: 5 } }),
    },
  });
  const cfg = loadGatewayConfig(env);
  assert.equal(cfg.status, 'invalid', 'an undefined policy reference must be fatal');
  assert.equal(cfg.ready, false, 'an undefined policy reference must refuse service');
  assert.ok(cfg.diagnostics.some((d) => d.includes('missing-policy')),
    `unknown policy reference must be flagged, got ${cfg.diagnostics}`);
});

// ---- Strict MODELS_CONFIG / POLICIES_CONFIG defaults still serve -----------
// A VALID aux config must not trip degraded, and getPolicy must still resolve.

test('valid MODELS_CONFIG + POLICIES_CONFIG resolve and stay ready', () => {
  const env = makeEnv({
    tier1: [node('g1')],
    secrets: { g1: 'k' },
    extraEnv: {
      MODELS_CONFIG: JSON.stringify({ 'general-air': { policy: 'fast', capabilities: { tools: true } } }),
      POLICIES_CONFIG: JSON.stringify({ fast: { max_attempts: 6, tier_attempts: { tier1: 4, tier2: 1 } } }),
    },
  });
  const cfg = loadGatewayConfig(env);
  assert.equal(cfg.status, 'ready', 'a valid aux config must not degrade the gateway');
  assert.equal(cfg.diagnostics.length, 0, 'valid config yields no diagnostics');
});

if (!process.exitCode) console.log(`gateway configuration tests passed (${passed}).`);
else process.exit(1);
