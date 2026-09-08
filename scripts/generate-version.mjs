import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const outputPath = path.join(root, 'src', 'config', 'version.ts');
const content = `// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Studio
//
// Auto-generated from package.json. Do not edit manually.
// Run 'node scripts/generate-version.mjs' to update.

export const VERSION = '${version}';
`;

fs.writeFileSync(outputPath, content, 'utf8');
console.log(`Generated ${outputPath} with version ${version}`);