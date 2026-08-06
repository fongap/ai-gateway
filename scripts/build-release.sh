#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
npm run verify
mkdir -p release
OUT="release/smart-edge-gateway-v5.11.0.tar.gz"
tar \
  --exclude='./node_modules' \
  --exclude='./.wrangler' \
  --exclude='./.git' \
  --exclude='./release' \
  --exclude='./.dev.vars' \
  --exclude='./secrets*.json' \
  -czf "$OUT" .
echo "已生成 $OUT"
