#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
npx --yes wrangler@4.114.0 whoami
WORKER_NAME="$(node -p "JSON.parse(require('fs').readFileSync('wrangler.jsonc','utf8')).name")"
printf '%s
' "目标 Worker：${WORKER_NAME}"
read -r -p '确认关闭上述 Worker 的全部 Fallback 并删除旧 Fallback Secret？[y/N]: ' answer
[[ "$answer" =~ ^([yY]|[yY][eE][sS])$ ]] || { echo '已取消。'; exit 1; }
TEMP="$(mktemp "${TMPDIR:-/tmp}/gateway-disable-fallback.XXXXXX.json")"; chmod 600 "$TEMP"
trap 'rm -f "$TEMP"' EXIT
cat > "$TEMP" <<'JSON'
{
  "FALLBACK_ENABLED": "false",
  "FALLBACK_SECONDARY_MODEL": "off",
  "FALLBACK_API_TOKEN": null,
  "FALLBACK_BASE_URL": null,
  "FALLBACK_PRIMARY_MODEL": null,
  "FALLBACK_PRIMARY_TOKEN": null,
  "FALLBACK_PRIMARY_BASE_URL": null,
  "FALLBACK_SECONDARY_TOKEN": null,
  "FALLBACK_SECONDARY_BASE_URL": null
}
JSON
npx --yes wrangler@4.114.0 secret bulk "$TEMP"
echo 'Fallback 已关闭，旧 Fallback Secret 已删除；未重新部署本地代码。'

