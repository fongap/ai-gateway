// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Single Node Attempt — one upstream request against one chosen node.
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
//
// The native / fallback tier loop drives this. attempt.js never owns
// tier ordering, candidate selection, hedge eligibility, or budget
// accounting beyond a single attempt's headers / first-event slice.
//
// PR 4 is a behavior-preserving refactor: the implementation stays
// in handler.js for now. This file is the new public boundary that
// the tier loop imports. The body relocation happens in PR 5, after
// the orchestrator structure is proven out.
