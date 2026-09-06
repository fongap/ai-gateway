// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Failover policy shape resolved for a logical model. Module successor of
// the ambient declaration in src/types/domain.d.ts (see src/types/protocol.ts
// header for the transition plan).

export type PolicyConfig = {
  maxAttempts: number,
  tierAttempts?: { tier1?: number, tier2?: number, tier3?: number } | null,
  hedge?: { enabled?: boolean, delayMs?: number, tiers?: ReadonlyArray<'tier1' | 'tier2' | 'tier3'> } | null,
  firstEventTimeoutMs?: number | null,
};
