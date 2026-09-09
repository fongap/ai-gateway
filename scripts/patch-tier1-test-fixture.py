from pathlib import Path

p = Path('scripts/scheduler-stability-test.mjs')
s = p.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global s
    if old not in s:
        raise SystemExit(f'test fixture anchor missing: {label}')
    s = s.replace(old, new, 1)


replace_once(
    "function node(id, { concurrency = 2, rpm = 100, models = { m1: 'up-x' } } = {}) {",
    "function node(id, { concurrency = 2, rpm = 0, models = { m1: 'up-x' } } = {}) {",
    'default rpm',
)

replace_once(
    "  const nodes = Array.from({ length: 15 }, (_, i) => node(`pool-${String(i).padStart(2, '0')}`, { concurrency: 20, rpm: 10_000 }));\n  const rateLimit = classifyTier1Failure({ kind: 'rate_limit' }, { retryAfterMs: 60_000 });",
    "  const nodes = Array.from({ length: 15 }, (_, i) => node(`pool-${String(i).padStart(2, '0')}`, { concurrency: 20, rpm: 10_000 }));\n  const simulationStart = Date.now();\n  const rateLimit = classifyTier1Failure({ kind: 'rate_limit' }, { retryAfterMs: 60_000 });",
    'simulation clock',
)

replace_once(
    "  for (const n of nodes.slice(0, 3)) applyTier1Outcome(n.id, 'm1', rateLimit);",
    "  for (const n of nodes.slice(0, 3)) applyTier1Outcome(n.id, 'm1', rateLimit, simulationStart);",
    'rate limit simulation clock',
)

replace_once(
    "    for (let i = 0; i < 3; i++) applyTier1Outcome(n.id, 'm1', timeout);",
    "    for (let i = 0; i < 3; i++) applyTier1Outcome(n.id, 'm1', timeout, simulationStart);",
    'timeout simulation clock',
)

replace_once(
    "    const pick = pickTier1Candidate(nodes, REQ, new Set(), { rng });",
    "    const pick = pickTier1Candidate(nodes, REQ, new Set(), { rng, now: simulationStart + i * 10 });",
    'pool simulation clock',
)

replace_once(
    """    const pick = pickTier1Candidate([affinity, peer], REQ, new Set(), {
      affinityAccountId: affinity.id, evaluateAffinity: false, rng,
    });""",
    """    const pick = pickTier1Candidate([affinity, peer], REQ, new Set(), {
      affinityAccountId: affinity.id, evaluateAffinity: false, rng,
      now: simulationStart + 6_000 + i * 10,
    });""",
    'affinity simulation clock',
)

replace_once(
    """  const escaped = pickTier1Candidate([affinity, peer], REQ, new Set(), {
    affinityAccountId: affinity.id, evaluateAffinity: true, rng,
  });""",
    """  const escaped = pickTier1Candidate([affinity, peer], REQ, new Set(), {
    affinityAccountId: affinity.id, evaluateAffinity: true, rng,
    now: simulationStart + 6_200,
  });""",
    'escape simulation clock',
)

p.write_text(s)
