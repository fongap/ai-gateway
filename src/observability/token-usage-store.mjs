// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Backward-compatibility shim. The actual implementation lives in
// the ./token-usage-store/ directory; this file re-exports the public
// surface so every existing import of
// '../observability/token-usage-store.mjs' keeps working unchanged.
//
// The split:
//   ./token-usage-store/keys.js       shared constants + timezone math
//   ./token-usage-store/writer.js     persistTokenUsage (hot path)
//   ./token-usage-store/queries.js    read paths (dashboard / model-status / TTFT)
//   ./token-usage-store/aggregation.js hourly -> daily -> weekly
//   ./token-usage-store/retention.js  cleanup + maintainUsageStats
//   ./token-usage-store/index.js      public re-export surface

export * from './token-usage-store/index.js';
