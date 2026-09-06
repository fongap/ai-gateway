// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Runtime Node shape produced by the config layer. Module successor of the
// ambient declarations in src/types/domain.d.ts (see src/types/protocol.ts
// header for the transition plan).

import type { Protocol, Surface } from './protocol.ts';

/** The node-level tier label used by the config layer and reliability state
 * (distinct from the numeric policy Tier). */
export type NodeTier = 'tier-1' | 'tier-2' | 'tier-3';

/**
 *   empty object {} means "wildcard" (node serves any model)
 *   non-empty maps the gateway's logical model to the upstream's model name
 */
export type NodeModelMap = { [logicalModel: string]: string };

export type RuntimeNode = {
  id: string,
  tier: NodeTier,
  provider: string,
  protocol: Protocol,
  surfaces: ReadonlyArray<Surface>,
  baseUrl: string,
  credential: string,
  priority: number,
  models: NodeModelMap,
  limits: {
    concurrency: number,
    rpm?: number,
    rpmMode?: 'soft' | 'hard',
  },
};
