#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def replace_exact(path, old, new):
    p = ROOT / path
    s = p.read_text(encoding='utf-8')
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly 1 match, found {count}')
    p.write_text(s.replace(old, new, 1), encoding='utf-8')

# Fix a typo introduced while restoring the parser manually.
replace_exact(
    'src/config/nodes.ts',
    'diagnostics.push(`${sourceKey}: node id "${nodeId}" models array entries must be non-empty strings`);',
    'diagnostics.push(`node "${nodeId}": models array entries must be non-empty strings`);',
)

# Gateway config contract: implicit transport remains supported; removed limits stay removed.
replace_exact(
    'tests/gateway-configuration-test.mjs',
'''test('protocol and surfaces are required; implicit legacy defaults are rejected', () => {
  const missingBoth = { id: 'old-01', provider: 'nvidia', base_url: 'https://old.example.com/v1', models: {} };
  const a = loadGatewayConfig(makeEnv({ tier1: [missingBoth], secrets: { 'old-01': 'x' } }));
  assert.equal(a.status, 'invalid');
  assert.ok(a.diagnostics.some((d) => d.includes('protocol is required')));

  const missingSurface = { id: 'an-01', provider: 'anthropic', protocol: 'anthropic', base_url: 'https://an.example.com', models: {} };
  const b = loadGatewayConfig(makeEnv({ tier1: [missingSurface], secrets: { 'an-01': 'x' } }));
  assert.equal(b.status, 'invalid');
  assert.ok(b.diagnostics.some((d) => d.includes('surfaces is required')));
});''',
'''test('nodes without protocol/surfaces keep the established transport defaults', () => {
  const legacy = { id: 'old-01', provider: 'nvidia', base_url: 'https://old.example.com/v1', models: {} };
  const cfg = loadGatewayConfig(makeEnv({ tier1: [legacy], secrets: { 'old-01': 'x' } }));
  assert.equal(cfg.status, 'ready');
  assert.equal(cfg.ready, true);
  assert.equal(cfg.nodes.length, 1);
  assert.equal(cfg.nodes[0].protocol, 'openai');
  assert.deepEqual(cfg.nodes[0].surfaces, ['chat_completions']);
  assert.ok(cfg.diagnostics.some((d) => d.includes('old-01') && d.includes('protocol is implicit')));
  assert.ok(cfg.diagnostics.some((d) => d.includes('old-01') && d.includes('surfaces is implicit')));
});

test('anthropic protocol without surfaces defaults to messages', () => {
  const nodeWithoutSurface = { id: 'an-01', provider: 'anthropic', protocol: 'anthropic', base_url: 'https://an.example.com', models: {} };
  const cfg = loadGatewayConfig(makeEnv({ tier1: [nodeWithoutSurface], secrets: { 'an-01': 'x' } }));
  assert.equal(cfg.status, 'ready');
  assert.deepEqual(cfg.nodes[0].surfaces, ['messages']);
});''',
)

# Protocol matrix: verify the same real request behavior used by production config.
replace_exact(
    'tests/protocol-matrix-test.mjs',
'''await test('node config without protocol/surfaces is rejected instead of inferred', async () => {
  resetMock();
  const legacyNode = { id: 'legacy-01', provider: 'nvidia', base_url: 'https://legacy.example.com/v1', priority: 10, models: { max: 'up-model' } };
  const env = makeEnv({ tier1: [legacyNode], secrets: { 'legacy-01': 'k' } });
  const health = await worker.fetch(new Request('https://gateway.example.com/health', { headers: { authorization: `Bearer ${ACCESS_KEY}` } }), env, {});
  assert.equal(health.status, 503);
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'invalid');
  assert.ok(healthBody.diagnostics.some((d) => d.includes('legacy-01') && d.includes('protocol is required')));
  assert.deepEqual(upstreamCalls, []);
});''',
'''await test('node config without protocol/surfaces serves chat with established defaults', async () => {
  resetMock();
  routeHandlers['legacy.example.com'] = () => jsonUpstream(okCompletion());
  const legacyNode = { id: 'legacy-01', provider: 'nvidia', base_url: 'https://legacy.example.com/v1', priority: 10, models: { max: 'up-model' } };
  const env = makeEnv({ tier1: [legacyNode], secrets: { 'legacy-01': 'k' } });
  const health = await worker.fetch(new Request('https://gateway.example.com/health', { headers: { authorization: `Bearer ${ACCESS_KEY}` } }), env, {});
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.status, 'ready');
  assert.ok(healthBody.diagnostics.some((d) => d.includes('legacy-01') && d.includes('protocol is implicit')));
  assert.ok(healthBody.diagnostics.some((d) => d.includes('legacy-01') && d.includes('surfaces is implicit')));
  const res = await worker.fetch(chatRequest({}), env, {});
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls[0].path, '/v1/chat/completions');
});''',
)

# Black-box integration: production-style node config must remain routable.
replace_exact(
    'tests/integration-test.mjs',
'''await test('protocol and surfaces are mandatory; no implicit legacy defaults remain', async () => {
  const invalid = {
    id: 'implicit', provider: 'mock', base_url: 'https://implicit.example.com/v1',
    models: { 'general-air': 'up-model' },
  };
  const env = makeEnv({ tier1: [invalid], secrets: { implicit: 'k' } });
  const health = await worker.fetch(new Request('https://gateway.example.com/health', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  assert.equal(health.status, 503);
  const body = await health.json();
  assert.equal(body.status, 'invalid');
  assert.ok(body.diagnostics.some((d) => d.includes('protocol is required')));
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 404);
  assert.equal(upstreamCalls.length, 0);
});''',
'''await test('production-style node config without protocol/surfaces remains routable', async () => {
  routeHandlers['implicit.example.com'] = () => jsonResponse(okChat('implicit-ok'));
  const implicit = {
    id: 'implicit', provider: 'mock', base_url: 'https://implicit.example.com/v1',
    models: { 'general-air': 'up-model' },
  };
  const env = makeEnv({ tier1: [implicit], secrets: { implicit: 'k' } });
  const health = await worker.fetch(new Request('https://gateway.example.com/health', {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  }), env, {});
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.status, 'ready');
  assert.ok(body.diagnostics.some((d) => d.includes('protocol is implicit')));
  assert.ok(body.diagnostics.some((d) => d.includes('surfaces is implicit')));
  const res = await worker.fetch(chatRequest(), env, {});
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].path, '/v1/chat/completions');
});''',
)

print('implicit transport compatibility repair applied')
