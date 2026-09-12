// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Provider-agnostic adaptive 429 cooldown for Tier 1 credentials.
//
// Scope is deliberately (provider, key-slot), never provider-only and never
// model-only. Runtime node ids are the non-secret identity of one configured
// credential/key; raw API keys are never stored or logged here.
//
// Escalation happens only when a 429 arrives after the previous cooldown has
// expired (normally the controlled recovery request). Extra 429 responses from
// requests that were already in flight during the same cooldown do NOT advance
// the ladder, preventing one burst from jumping straight to a one-hour block.

export const ADAPTIVE_429_COOLDOWN_STEPS_MS = Object.freeze([
  15_000,
  30_000,
  60_000,
  120_000,
  300_000,
  900_000,
  1_800_000,
  3_600_000,
] as const);

const MAX_ENTRIES = 512;

type Adaptive429State = {
  stage: number,
  cooldownUntil: number,
  last429At: number,
};

const states = new Map<string, Adaptive429State>();

function scopeKey(provider: string, keyId: string): string {
  return `${String(provider || '').trim().toLowerCase()}\u0000${String(keyId || '').trim()}`;
}

function automaticCooldownMs(stage: number): number {
  const index = Math.min(
    Math.max(0, stage - 1),
    ADAPTIVE_429_COOLDOWN_STEPS_MS.length - 1,
  );
  return ADAPTIVE_429_COOLDOWN_STEPS_MS[index];
}

function pruneIfNeeded(): void {
  if (states.size <= MAX_ENTRIES) return;
  const entries = [...states.entries()].sort((a, b) => a[1].last429At - b[1].last429At);
  const remove = states.size - Math.floor(MAX_ENTRIES * 0.75);
  for (let i = 0; i < remove; i++) states.delete(entries[i][0]);
}

/**
 * Returns the cooldown to apply for this 429.
 *
 * retryAfterMs is treated as a minimum provider hint. Repeated recovery 429s
 * may extend beyond it; a provider hint never shortens the adaptive ladder.
 */
export function nextAdaptive429CooldownMs(
  provider: string,
  keyId: string,
  retryAfterMs: number = 0,
  now: number = Date.now(),
): number {
  const key = scopeKey(provider, keyId);
  const explicit = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.round(retryAfterMs) : 0;
  let state = states.get(key);

  if (!state) {
    state = { stage: 1, cooldownUntil: 0, last429At: now };
  } else if (state.cooldownUntil <= now) {
    state.stage = Math.min(state.stage + 1, ADAPTIVE_429_COOLDOWN_STEPS_MS.length);
  }

  const adaptive = automaticCooldownMs(state.stage);
  const requestedUntil = now + Math.max(adaptive, explicit);
  state.cooldownUntil = Math.max(state.cooldownUntil, requestedUntil);
  state.last429At = now;
  states.set(key, state);
  pruneIfNeeded();

  return Math.max(1, state.cooldownUntil - now);
}

/** Clear only after a real recovery request succeeds. */
export function clearAdaptive429State(provider: string, keyId: string): void {
  states.delete(scopeKey(provider, keyId));
}

export function snapshotAdaptive429State(provider: string, keyId: string, now: number = Date.now()) {
  const state = states.get(scopeKey(provider, keyId));
  if (!state) return { stage: 0, cooldown_remaining_ms: 0 };
  return {
    stage: state.stage,
    cooldown_remaining_ms: Math.max(0, state.cooldownUntil - now),
  };
}

export function __resetAdaptive429StateForTests(): void {
  states.clear();
}
