// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Failover policy shape resolved for a logical model. Canonical type
// consumed by the scheduler and request layers (src/types/domain.d.ts
// has been deleted — see docs/governance/typescript-migration.md).

export type PolicyConfig = {
  maxAttempts: number,
  tierAttempts?: { tier1?: number, tier2?: number, tier3?: number } | null,
  hedge?: { enabled?: boolean, delayMs?: number, tiers?: ReadonlyArray<'tier1' | 'tier2' | 'tier3'> } | null,
  firstEventTimeoutMs?: number | null,
  // Adaptive Budget. `budget_split` controls how the per-tier
  // attempt surplus (max_attempts - dispatchable_tier_count) is distributed
  // across dispatchable tiers:
  //   'even' (default, backward-compatible): the first (most-preferred)
  //     dispatchable tier receives the ENTIRE surplus, maximizing free /
  //     priority resource use. Existing tests and behavior are unchanged.
  //   'weighted': the surplus is distributed proportionally to each tier's
  //     live dispatchable node count. A tier with 3 dispatchable nodes gets
  //     3x the surplus share of a tier with 1 dispatchable node. This is
  //     useful when a lower tier has significantly more capacity than the
  //     preferred tier and the operator wants to spread risk rather than
  //     concentrating all surplus on the highest-priority tier.
  // When `tierAttempts` is explicitly set for a tier, that override wins
  // and `budget_split` does not apply to that tier.
  budgetSplit?: 'even' | 'weighted' | null,
};
