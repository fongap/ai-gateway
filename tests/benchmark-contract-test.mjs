#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const benchmark = fs.readFileSync(path.join(root, 'benchmark', 'benchmark.mjs'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const standaloneKey = 'GATEWAY_ACCESS_' + 'KEY';
const standalonePattern = new RegExp(`\\b${standaloneKey}\\b(?!_)`);

assert.match(benchmark, /from ['"]\.\.\/src\/index\.ts['"]/, 'benchmark must import the current TypeScript Worker entry');
assert.doesNotMatch(benchmark, /\.\.\/src\/index\.js/, 'benchmark must not reference the removed JavaScript Worker entry');
assert.doesNotMatch(benchmark, standalonePattern, 'benchmark must not use the removed standalone gateway access key');
assert.match(benchmark, /GATEWAY_ACCESS_KEY_AIR/, 'benchmark must authenticate through a current grouped access key');
assert.match(benchmark, /GATEWAY_ACCESS_MODELS_AIR/, 'benchmark must grant its benchmark model through the matching group allowlist');
assert.match(pkg.scripts?.bench || '', /benchmark\/benchmark\.mjs\s+--quick/, 'npm run bench must execute the short benchmark');
assert.match(pkg.scripts?.['bench:full'] || '', /benchmark\/benchmark\.mjs/, 'npm run bench:full must execute the full benchmark');

console.log('benchmark contract tests passed.');
