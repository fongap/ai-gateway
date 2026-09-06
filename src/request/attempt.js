// SPDX-License-Identifier: MIT
// @ts-check
// Copyright (c) 2026 Fongap Studio
//
// Single Node Attempt - the public attempt boundary.
//
// This file IS the stable public boundary: handler.js drives the native /
// fallback tier loop via dispatchWithHedge(args, tierNodes) from here. The
// implementation lives in ./attempt/ (see its index.js for the module map):
//
//   attempt/index.js         boundary re-exports (this file's entire surface)
//   attempt/dispatch.js      outbound prep, timeouts, fetch, classification
//   attempt/hedge.js         hedge race, twin selection, winner/loser lifecycle
//   attempt/success.js       first-event guard + per-protocol success handling
//   attempt/outcome.js       AttemptOutcome + accounting (attempt vs dispatch)
//   attempt/observability.js token/D1/stream/node-success recording
//
// Responsibility split (kept out of this module):
//   Scheduler   = decides WHICH node to attempt (not the picker)
//   Reliability = decides how an outcome mutates node state (public API only)
//   Transport   = how to talk to the upstream (path, headers, stream)
//   Protocol    = validates the upstream response and synthesizes one when
//                 the upstream lied about its content type.

export { attemptNode, dispatchWithHedge } from './attempt/index.js';
