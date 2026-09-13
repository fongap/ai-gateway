// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Runtime Node shape produced by the strict config layer. Capacity is learned
// from live reliability signals; operator-guessed per-node limits are not part
// of the runtime contract.

import type { Protocol, Surface } from './protocol.ts';

export type NodeTier = 'tier-1' | 'tier-2' | 'tier-3';

/**
 *   empty object {} means "wildcard" (node serves any model in the known catalog)
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
};
