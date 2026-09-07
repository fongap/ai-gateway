// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Backward-compatibility shim. The actual implementation lives in
// the ./token-usage-store/ directory; this file re-exports the public
// surface so every existing import of
// '../observability/token-usage-store.ts' keeps working unchanged.
//
// The split:
//   ./token-usage-store/keys.ts       shared constants + timezone math
//   ./token-usage-store/writer.ts     persistTokenUsage (hot path)
//   ./token-usage-store/queries.ts    read paths (dashboard / model-status / TTFT)
//   ./token-usage-store/aggregation.ts hourly -> daily -> weekly
//   ./token-usage-store/retention.ts  cleanup + maintainUsageStats
//   ./token-usage-store/index.ts      public re-export surface

export * from './token-usage-store/index.ts';
