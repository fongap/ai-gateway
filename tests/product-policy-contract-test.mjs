#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Permanent product/governance contract. These checks intentionally pin the
// product boundary so later architecture work cannot silently turn ai-gateway
// into a public SaaS/control plane, blur tier roles, or reintroduce old-version
// compatibility layers.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const product = read('docs/governance/product-policy.md');
const development = read('docs/governance/development-policy.md');
const overview = read('docs/architecture/overview.md');

assert.match(product, /household, an individual operator, or a small trusted team/i,
  'product scope must remain household/individual/small-team');
assert.match(product, /Tier 1 — free-token capacity/i,
  'Tier 1 must remain the free-token capacity layer');
assert.match(product, /Tier 2 — membership\/subscription entitlement capacity/i,
  'Tier 2 must remain reserved for membership/subscription entitlements');
assert.match(product, /Tier 3 — paid API subscription capacity/i,
  'Tier 3 must remain reserved for paid API capacity');
assert.match(product, /does not preserve backward compatibility with older ai-gateway versions/i,
  'old ai-gateway versions must not drive runtime compatibility code');
assert.match(product, /do not add aliases, dual-read\/dual-write paths, deprecation windows, version switches, or compatibility shims/i,
  'compatibility shims and dual old/new paths must remain forbidden');
assert.match(product, /Prefer deletion over preserving obsolete transitional design/i,
  'obsolete transitional design must be deleted rather than preserved');

assert.match(development, /Clean replacement rule/i,
  'development policy must enforce clean replacement');
assert.match(development, /remove the superseded path in the same change/i,
  'superseded paths must be removed in the same change');
assert.match(development, /Tier 1 is free-token capacity.*Tier 2 is reserved for membership\/subscription entitlements.*Tier 3 is reserved for paid API capacity/is,
  'development policy must preserve fixed tier roles');

assert.match(overview, /Tier 1.*Free or effectively free token capacity/is,
  'architecture overview must document Tier 1 role');
assert.match(overview, /Tier 2.*Membership\/subscription entitlement capacity/is,
  'architecture overview must document Tier 2 role');
assert.match(overview, /Tier 3.*Paid API capacity/is,
  'architecture overview must document Tier 3 role');

console.log('product policy contract tests passed.');
