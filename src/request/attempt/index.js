// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Attempt Boundary - internal module map.
//
// src/request/attempt.js remains the stable public boundary (handler.js
// imports attemptNode / dispatchWithHedge from it); this directory holds the
// split internals:
//
//   dispatch.js       one node attempt: outbound prep, timeouts, fetch,
//                     non-OK / network / client-abort classification entry
//   hedge.js          hedge delay race, twin selection, shared deadline,
//                     winner/loser lifecycle + abort
//   success.js        first-event guard, stream passthrough/transforms,
//                     per-protocol success result handling
//   outcome.js        AttemptOutcome construction, failure/rotate/stop,
//                     logical attempt vs dispatch accounting
//   observability.js  token accounting, D1 persistence scheduling, stream
//                     metrics, node success/TTFT recording (never affects
//                     scheduling decisions)
//
// Dependency direction (acyclic):
//   attempt.js -> index.js -> { dispatch.js -> success.js -> observability.js,
//   dispatch.js -> outcome.js, hedge.js -> dispatch.js }.
// No module here imports handler.js, and nothing under reliability/ or
// transport/ imports anything from request/.

export { attemptNode } from './dispatch.js';
export { dispatchWithHedge } from './hedge.js';
