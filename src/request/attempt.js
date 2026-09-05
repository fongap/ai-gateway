// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Single Node Attempt — one upstream request against one chosen node.
//
// This file IS the public attempt boundary. The native / fallback tier loop
// (handler.js) drives it via dispatchWithHedge(args, tierNodes).
//
// Responsibility split (kept out of this module):
//   Scheduler   = decides WHICH node to attempt (this file is not the picker)
//   Reliability = decides how an attempt's outcome mutates node state
//                 (this file calls the public Reliability API; it does not
//                 reimplement cooldowns, half-open, RPM, or circuit math).
//   Transport   = how to talk to the upstream (path, headers, stream).
//   Protocol    = validates the upstream response and synthesizes one
//                 when the upstream lied about its content type.
//
// What this module owns:
//   - preparing the outbound request (URL, headers, body, conversion ctx)
//   - dispatching (with optional hedge) and acquiring the headers/first-
//     event timeout
//   - first-event guard for the streaming path
//   - classifying the upstream outcome (status / network / first-event /
//     client abort / malformed)
//   - building the AttemptOutcome and feeding it to Reliability + the
//     streaming observability callbacks
//   - attempt-level success/failure finalization
//
// The native / fallback tier loop drives this. attempt.js never owns
// tier ordering, candidate selection, hedge eligibility, or budget
// accounting beyond a single attempt's headers / first-event slice.
//
// The full dispatch implementation (dispatchAttempt, dispatchWithHedge,
// handleSuccess) currently lives in handler.js. This module re-exports
// the public symbols so external code imports them from the stable
// attempt boundary. The body relocation to this file is planned as a
// separate behavior-preserving refactor; until then, handler.js should
// not import attempt symbols from this file (that would re-introduce
// the cycle being removed in stages).

export { attemptNode, dispatchWithHedge } from './handler.js';
