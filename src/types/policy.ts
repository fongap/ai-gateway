// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Failover policy shape resolved for a logical model.

export type PolicyConfig = {
  maxAttempts: number,
  tierAttempts?: { tier1?: number, tier2?: number, tier3?: number } | null,
  hedge?: { enabled?: boolean, delayMs?: number, tiers?: ReadonlyArray<'tier1' | 'tier2' | 'tier3'> } | null,
  firstEventTimeoutMs?: number | null,
  // Optional isolate-local admission ceiling for a Tier 1 account. Built-in
  // policies default to null/unlimited. Set a positive integer only when the
  // upstream has a KNOWN per-account concurrency contract; 0/null/unset means
  // no hard ceiling. This is not a learned or cluster-wide Provider quota.
  maxInFlight?: number | null,
};
