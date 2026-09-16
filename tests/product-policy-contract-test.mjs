#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const product = read('docs/governance/product-policy.md');
const development = read('docs/governance/development-policy.md');
const overview = read('docs/architecture/overview.md');

assert.match(product, /household, an individual operator, or a small trusted team/i);
assert.match(product, /Tier 1 — free-token capacity/i);
assert.match(product, /Tier 2 — membership\/subscription entitlement capacity/i);
assert.match(product, /Tier 3 — paid API capacity/i);
assert.match(product, /maintains one current contract/i,
  'repository must keep one current contract');
assert.match(product, /do not add aliases, dual-read\/dual-write paths, deprecation windows, compatibility switches, or shims/i,
  'retired contract shims must stay forbidden');
assert.match(product, /Project release numbering is human-owned only/i,
  'release numbering must stay human-owned');
assert.match(product, /human creates the Git tag or GitHub Release manually/i,
  'named releases must remain explicit human actions');
assert.match(product, /Automation must never create or advance release numbering/i,
  'automation must not own release numbering');
assert.match(product, /Prefer deletion over preserving obsolete transitional design/i,
  'obsolete transitional design must be deleted');

assert.match(development, /Clean replacement rule/i);
assert.match(development, /remove the superseded path in the same change/i);
assert.match(development, /Tier 1 is free-token capacity.*Tier 2 is reserved for membership\/subscription entitlements.*Tier 3 is reserved for paid API capacity/is);
assert.match(development, /Project release numbering is not an engineering automation concern/i);

assert.match(overview, /Tier 1.*Free or effectively free token capacity/is);
assert.match(overview, /Tier 2.*Membership\/subscription entitlement capacity/is);
assert.match(overview, /Tier 3.*Paid API capacity/is);

console.log('product policy contract tests passed.');
