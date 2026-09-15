#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Regression contract for policy-level Tier 1 admission ceilings.
// The gateway must not invent a per-account concurrency ceiling by default;
// operators may opt into one explicitly when they know the upstream contract.

import assert from 'node:assert/strict';
import { loadPoliciesConfig, getPoliciesConfigDiagnostics } from '../src/config/policies.ts';

function policies(config) {
  const env = config === undefined ? {} : { POLICIES_CONFIG: JSON.stringify(config) };
  return loadPoliciesConfig(env);
}

assert.equal(policies().default.maxInFlight, null,
  'built-in default policy must not impose a guessed concurrency ceiling');
assert.equal(policies().fast.maxInFlight, null,
  'built-in fast policy must not impose a guessed concurrency ceiling');
assert.equal(policies()['long-reasoning'].maxInFlight, null,
  'built-in long-reasoning policy must not impose a guessed concurrency ceiling');

assert.equal(policies({ custom: { max_attempts: 5 } }).custom.maxInFlight, null,
  'custom policy without max_in_flight must stay unlimited');
assert.equal(policies({ default: { max_in_flight: 0 } }).default.maxInFlight, null,
  'max_in_flight=0 explicitly disables the ceiling');
assert.equal(policies({ default: { max_in_flight: null } }).default.maxInFlight, null,
  'max_in_flight=null explicitly disables the ceiling');
assert.equal(policies({ default: { max_in_flight: 4 } }).default.maxInFlight, 4,
  'positive max_in_flight remains an explicit operator admission ceiling');

const badEnv = { POLICIES_CONFIG: JSON.stringify({ default: { max_in_flight: -1 } }) };
const badDiags = getPoliciesConfigDiagnostics(badEnv);
assert.ok(badDiags.some((d) => d.includes('max_in_flight must be a non-negative integer')),
  `invalid max_in_flight must be diagnosed, got ${JSON.stringify(badDiags)}`);
assert.equal(loadPoliciesConfig(badEnv).default.maxInFlight, null,
  'invalid max_in_flight must never silently re-enable an arbitrary fallback ceiling');

console.log('policy max_in_flight tests passed.');
