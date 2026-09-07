// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Scheduler-layer shared types. Canonical source for Tier, RoutableRequest,
// and PickedCandidate, consumed by the scheduler and request layers
// (src/types/domain.d.ts has been deleted — see
// docs/governance/typescript-migration.md).

import type { RuntimeNode } from './node.ts';
import type { Protocol, Surface } from './protocol.ts';

/** Numeric policy tier (distinct from the NodeTier label). */
export type Tier = 1 | 2 | 3;

/**
 * Minimal routable request shape consumed by the scheduler's static
 * eligibility checks (supportsRequest and the Tier 1 equivalents). The tier
 * loop passes the RequestDescriptor of the current route plus the canonical
 * requested model — this is NOT the DOM Request.
 */
export type RoutableRequest = {
  model: string,
  protocol: Protocol,
  surface: Surface,
};

/**
 * A single decision returned by the scheduler when picking the next
 * candidate for a tier. The shape is shared by all tier pickers
 * (Tier 1 with affinity release token, Tier 2/3 with priority/LRU).
 */
export type PickedCandidate = {
  node?: RuntimeNode,
  raceLost?: boolean,
  releaseToken?: { accountId: string, released: boolean } | null,
  updateAffinity?: boolean,
  escapedFromAffinity?: boolean,
  affinityHit?: boolean,
};
