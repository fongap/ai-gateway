#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
npm ci
npm run verify
npx --yes wrangler@4.114.0 deploy --keep-vars
