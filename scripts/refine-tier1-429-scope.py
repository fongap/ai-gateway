from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f'patch anchor missing: {label}')
    return text.replace(old, new, 1)


p = Path('src/reliability/tier1-state.ts')
s = p.read_text()

s = replace_once(s,
"""  lastObservedAt: number;
  scopeAmbiguous429: boolean;
};""",
"""  lastObservedAt: number;
  scopeAmbiguous429: boolean;
  rateLimitRecoveryPending: boolean;
  rateLimitRecoveryUntil: number;
};""", 'model recovery fields')

s = replace_once(s,
"""  accountCooldownReason: string | null;
  consecutiveAccountFailures: number;
  quotaState: Tier1QuotaState;""",
"""  accountCooldownReason: string | null;
  consecutiveAccountFailures: number;
  rateLimitRecoveryPending: boolean;
  rateLimitRecoveryUntil: number;
  quotaState: Tier1QuotaState;""", 'account recovery fields')

s = replace_once(s,
"""    lastObservedAt: 0,
    scopeAmbiguous429: false,
  };""",
"""    lastObservedAt: 0,
    scopeAmbiguous429: false,
    rateLimitRecoveryPending: false,
    rateLimitRecoveryUntil: 0,
  };""", 'model recovery init')

s = replace_once(s,
"""    accountCooldownReason: null,
    consecutiveAccountFailures: 0,
    quotaState: 'normal',""",
"""    accountCooldownReason: null,
    consecutiveAccountFailures: 0,
    rateLimitRecoveryPending: false,
    rateLimitRecoveryUntil: 0,
    quotaState: 'normal',""", 'account recovery init')

s = replace_once(s,
"""function deferTier1RpmAfterRateLimit(accountId: string, resumeAt: number): void {
  const bucket = rpmBuckets.get(accountId);
  if (!bucket || !Number.isFinite(bucket.rpm) || bucket.rpm <= 0) return;
  const intervalMs = 60_000 / bucket.rpm;
  // Resume with exactly one token at cooldown expiry, then refill normally.
  bucket.tokens = 0;
  bucket.updatedAt = Math.max(bucket.updatedAt, resumeAt - intervalMs);
}

export function claimTier1Slot(node: RuntimeNode, now: number = Date.now(), modelId: string | null = null): boolean {
  const account = getTier1Account(node.id);
  if (account.accountDisabled || account.accountCooldownUntil > now) return false;
  const model = modelId ? account.models.get(modelId) : null;
  if (model?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return false;
  if (account.inFlight >= node.limits.concurrency) return false;
  if (node.limits.rpm && node.limits.rpmMode !== 'soft'
    && !noteTier1Rpm(node.id, node.limits.rpm, now)) return false;
  account.inFlight++;
  return true;
}""",
"""export function claimTier1Slot(node: RuntimeNode, now: number = Date.now(), modelId: string | null = null): boolean {
  const account = getTier1Account(node.id);
  if (account.accountDisabled || account.accountCooldownUntil > now || account.rateLimitRecoveryUntil > now) return false;
  const model = modelId ? account.models.get(modelId) : null;
  if (model?.rateLimitRecoveryUntil && model.rateLimitRecoveryUntil > now) return false;
  if (model?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return false;
  if (account.inFlight >= node.limits.concurrency) return false;

  const hardRpm = Boolean(node.limits.rpm && node.limits.rpmMode !== 'soft');
  if (hardRpm && !noteTier1Rpm(node.id, node.limits.rpm, now)) return false;

  account.inFlight++;
  // A 429 recovery is scoped exactly like the cooldown that caused it. The
  // first admitted request after cooldown starts a one-interval recovery gate;
  // model-scoped 429 never blocks sibling models, while account-scoped 429
  // intentionally gates the whole account. The shared RPM bucket itself is
  // never pushed into the future, so unrelated model traffic keeps flowing.
  if (account.rateLimitRecoveryPending) {
    account.rateLimitRecoveryPending = false;
    account.rateLimitRecoveryUntil = hardRpm ? now + (60_000 / node.limits.rpm) : 0;
  }
  if (model?.rateLimitRecoveryPending) {
    model.rateLimitRecoveryPending = false;
    model.rateLimitRecoveryUntil = hardRpm ? now + (60_000 / node.limits.rpm) : 0;
  }
  return true;
}""", 'scoped claim recovery')

s = replace_once(s,
"""  const account = accounts.get(node.id);
  if (!account) return true;
  if (account.accountDisabled || account.accountCooldownUntil > now) return false;
  if (modelBlocked(account.models.get(req.model), now)) return false;
  if (account.models.get(req.model)?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return false;""",
"""  const account = accounts.get(node.id);
  if (!account) return true;
  if (account.accountDisabled || account.accountCooldownUntil > now || account.rateLimitRecoveryUntil > now) return false;
  const model = account.models.get(req.model);
  if (modelBlocked(model, now) || (model?.rateLimitRecoveryUntil ?? 0) > now) return false;
  if (model?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return false;""", 'eligibility scoped recovery')

s = replace_once(s,
"""  if (outcome.scope === 'account') {
    account.consecutiveAccountFailures++;
    account.accountCooldownUntil = Math.max(account.accountCooldownUntil, now + (outcome.cooldownMs || TIER1_COOLDOWN_DEFAULT_MS));
    account.accountCooldownReason = outcome.reason;
    if (outcome.backoff === 'rate_limit') deferTier1RpmAfterRateLimit(accountId, account.accountCooldownUntil);
    return;
  }""",
"""  if (outcome.scope === 'account') {
    account.consecutiveAccountFailures++;
    account.accountCooldownUntil = Math.max(account.accountCooldownUntil, now + (outcome.cooldownMs || TIER1_COOLDOWN_DEFAULT_MS));
    account.accountCooldownReason = outcome.reason;
    if (outcome.backoff === 'rate_limit') {
      account.rateLimitRecoveryPending = true;
      account.rateLimitRecoveryUntil = 0;
    }
    return;
  }""", 'account scoped 429')

s = replace_once(s,
"""    model.cooldownUntil = now + cooldownMs;
    model.cooldownReason = outcome.reason;
    if (rateLimited) deferTier1RpmAfterRateLimit(accountId, model.cooldownUntil);
    if (halfOpenFailure || thresholdReached) {""",
"""    model.cooldownUntil = now + cooldownMs;
    model.cooldownReason = outcome.reason;
    if (rateLimited) {
      model.rateLimitRecoveryPending = true;
      model.rateLimitRecoveryUntil = 0;
    }
    if (halfOpenFailure || thresholdReached) {""", 'model scoped 429')

s = replace_once(s,
"""  if (!account || account.accountDisabled) return Infinity;
  if (account.accountCooldownUntil > now) return account.accountCooldownUntil - now;
  const model = account.models.get(modelId);
  if (model?.disabled) return Infinity;
  if (model && model.cooldownUntil > now) return model.cooldownUntil - now;""",
"""  if (!account || account.accountDisabled) return Infinity;
  if (account.accountCooldownUntil > now) return account.accountCooldownUntil - now;
  if (account.rateLimitRecoveryUntil > now) return account.rateLimitRecoveryUntil - now;
  const model = account.models.get(modelId);
  if (model?.disabled) return Infinity;
  if (model && model.cooldownUntil > now) return model.cooldownUntil - now;
  if (model && model.rateLimitRecoveryUntil > now) return model.rateLimitRecoveryUntil - now;""", 'blocking recovery wait')

s = replace_once(s,
"""    const account = accounts.get(node.id);
    if (!account || account.accountDisabled || account.accountCooldownUntil > now) continue;
    const model = account.models.get(req.model);
    if (modelBlocked(model, now)) continue;
    if (model?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return true;""",
"""    const account = accounts.get(node.id);
    if (!account || account.accountDisabled || account.accountCooldownUntil > now) continue;
    if (account.rateLimitRecoveryUntil > now) return true;
    const model = account.models.get(req.model);
    if (modelBlocked(model, now)) continue;
    if ((model?.rateLimitRecoveryUntil ?? 0) > now) return true;
    if (model?.failureState === FAILURE_STATE.HALF_OPEN && account.inFlight > 0) return true;""", 'deferred scoped recovery')

p.write_text(s)

p = Path('scripts/scheduler-stability-test.mjs')
s = p.read_text()
old = """await test('RPM: 429 cooldown resumes with one token, not a fresh burst', () => {
  const b = node('b', { concurrency: 10, rpm: 40 });
  const now = 1_000_000;
  assert.equal(claimTier1Slot(b, now, 'm1'), true);
  getTier1Account('b').inFlight--;
  const outcome = classifyTier1Failure({ kind: 'rate_limit' }, { retryAfterMs: 10_000 });
  applyTier1Outcome('b', 'm1', outcome, now);
  assert.equal(isTier1Eligible(b, REQ, now + 9_999), false, 'Retry-After cooldown remains authoritative');
  assert.equal(isTier1Eligible(b, REQ, now + 10_000), true, 'one request may resume at cooldown expiry');
  assert.equal(claimTier1Slot(b, now + 10_000, 'm1'), true);
  getTier1Account('b').inFlight--;
  assert.equal(claimTier1Slot(b, now + 10_000, 'm1'), false, 'post-429 resume must not burst immediately');
});"""
new = """await test('RPM: model-scoped 429 recovery suppresses same-model burst without blocking siblings', () => {
  const b = node('b', { concurrency: 10, rpm: 40, models: { m1: 'up-1', m2: 'up-2' } });
  const now = 1_000_000;
  assert.equal(claimTier1Slot(b, now, 'm1'), true);
  getTier1Account('b').inFlight--;
  const outcome = classifyTier1Failure({ kind: 'rate_limit' }, { retryAfterMs: 10_000 });
  applyTier1Outcome('b', 'm1', outcome, now);
  assert.equal(isTier1Eligible(b, REQ, now + 9_999), false, 'Retry-After cooldown remains authoritative');
  assert.equal(isTier1Eligible(b, { ...REQ, model: 'm2' }, now + 1), true, 'model-scoped 429 must not block sibling models');
  assert.equal(claimTier1Slot(b, now + 1, 'm2'), true, 'sibling model may keep using remaining account RPM capacity');
  getTier1Account('b').inFlight--;
  assert.equal(isTier1Eligible(b, REQ, now + 10_000), true, 'one m1 request may resume at cooldown expiry');
  assert.equal(claimTier1Slot(b, now + 10_000, 'm1'), true);
  getTier1Account('b').inFlight--;
  assert.equal(claimTier1Slot(b, now + 10_000, 'm1'), false, 'same model must not burst immediately after 429 recovery');
  assert.equal(isTier1Eligible(b, { ...REQ, model: 'm2' }, now + 10_000), true, 'recovery gate remains model-local');
  assert.equal(claimTier1Slot(b, now + 11_500, 'm1'), true, 'same model resumes after one RPM interval');
});

await test('RPM: explicit account-scoped 429 recovery gates the whole account for one interval', () => {
  const b = node('b', { concurrency: 10, rpm: 40, models: { m1: 'up-1', m2: 'up-2' } });
  const now = 2_000_000;
  assert.equal(claimTier1Slot(b, now, 'm1'), true);
  getTier1Account('b').inFlight--;
  const outcome = classifyTier1Failure({ kind: 'rate_limit', rateLimitScope: 'account' }, { retryAfterMs: 10_000 });
  applyTier1Outcome('b', 'm1', outcome, now);
  assert.equal(isTier1Eligible(b, REQ, now + 10_000), true);
  assert.equal(claimTier1Slot(b, now + 10_000, 'm1'), true);
  getTier1Account('b').inFlight--;
  assert.equal(isTier1Eligible(b, { ...REQ, model: 'm2' }, now + 10_000), false, 'account-scoped recovery gates sibling models');
  assert.equal(isTier1Eligible(b, { ...REQ, model: 'm2' }, now + 11_500), true, 'account gate expires after one RPM interval');
});"""
s = replace_once(s, old, new, '429 scoped tests')
p.write_text(s)

p = Path('docs/architecture/reliability-model.md')
s = p.read_text()
s = replace_once(s,
"429 仍沿用既有 `Retry-After` / model-scoped exponential backoff / rotate 语义。新增的唯一联动是：429 cooldown 到期时 admission bucket 只恢复 1 个 token，之后继续按 `limits.rpm` 平滑补充，避免 cooldown 结束瞬间再次 burst → 429。",
"429 仍沿用既有 `Retry-After` / model-scoped exponential backoff / rotate 语义。新增的唯一联动是 scoped recovery gate：cooldown 后首个真实准入成功后，同 scope 在 1 个 RPM interval 内不再立即二次准入；model-scoped 429 不影响 sibling models，显式 account-scoped 429 才作用于整个 account。共享 Token Bucket 不被推入未来。", 'reliability docs scope')
p.write_text(s)

p = Path('CHANGELOG.md')
s = p.read_text()
s = replace_once(s,
"- **429 Resume Shaping**: 保留现有 `Retry-After`、model-scoped exponential backoff、jitter 与 rotate；429 cooldown 到期时仅恢复 1 个 Tier 1 admission token，避免恢复瞬间再次 burst → 429。",
"- **429 Resume Shaping**: 保留现有 `Retry-After`、model-scoped exponential backoff、jitter 与 rotate；cooldown 后首个真实准入成功后，同 scope 增加 1 个 RPM interval 的 recovery gate。model-scoped 429 不影响 sibling models；仅显式 account-scoped 429 才作用于整个 account。", 'changelog scope')
p.write_text(s)
