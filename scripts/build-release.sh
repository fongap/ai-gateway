#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

command -v zip >/dev/null 2>&1 || { echo "zip command is required." >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar command is required." >&2; exit 1; }

npm run verify:release
npm run checksums
BASE_NAME="$(node scripts/release-meta.mjs artifact)"
node scripts/prepare-release.mjs >/dev/null

(
  cd release/.staging
  zip -qr "../${BASE_NAME}.zip" "${BASE_NAME}"
  tar -czf "../${BASE_NAME}.tar.gz" "${BASE_NAME}"
)

rm -rf release/.staging
(
  cd release
  sha256sum "${BASE_NAME}.zip" "${BASE_NAME}.tar.gz" > SHA256SUMS
)

echo "Release archives generated:"
echo "  release/${BASE_NAME}.zip"
echo "  release/${BASE_NAME}.tar.gz"
echo "  release/SHA256SUMS"
