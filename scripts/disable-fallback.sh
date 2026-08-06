#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
TEMP_FILE="$(mktemp "${TMPDIR:-/tmp}/smart-edge-gateway-disable-fallback.XXXXXX.json")"
trap 'rm -f "$TEMP_FILE"' EXIT
printf '%s\n' '{"FALLBACK_ENABLED":"false","FALLBACK_SECONDARY_MODEL":"off"}' > "$TEMP_FILE"
npx --yes wrangler@4.114.0 deploy --keep-vars --secrets-file "$TEMP_FILE"
echo "Fallback 已显式关闭；旧值即使仍保留，也不会被路由使用。"
