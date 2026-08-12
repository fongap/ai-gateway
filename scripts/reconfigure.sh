#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
fail(){ echo "错误：$*" >&2; exit 1; }
yesno(){ [[ "${1:-}" =~ ^([yY]|[yY][eE][sS])$ ]]; }
npx --yes wrangler@4.114.0 whoami
WORKER_NAME="$(node -p "JSON.parse(require('fs').readFileSync('wrangler.jsonc','utf8')).name")"
printf '%s
' "目标 Worker：${WORKER_NAME}"
read -r -s -p '新的 GATEWAY_ACCESS_KEY: ' GATEWAY_ACCESS_KEY; echo
read -r -s -p '新的 PRIMARY_API_TOKENS: ' PRIMARY_API_TOKENS; echo
read -r -p 'PRIMARY_BASE_URL（可留空）: ' PRIMARY_BASE_URL
[[ -n "$GATEWAY_ACCESS_KEY" && -n "$PRIMARY_API_TOKENS" ]] || fail '两个必需 Secret 均不能为空。'
PRIMARY_API_TOKENS="$PRIMARY_API_TOKENS" PRIMARY_BASE_URL="$PRIMARY_BASE_URL" node scripts/validate-primary-config.mjs
read -r -p 'MODEL_MAPPING JSON 文件路径（留空清除）: ' MODEL_MAPPING_PATH
MODEL_MAPPING=""
if [[ -n "$MODEL_MAPPING_PATH" ]]; then node scripts/validate-model-mapping.mjs "$MODEL_MAPPING_PATH"; MODEL_MAPPING="$(cat "$MODEL_MAPPING_PATH")"; fi
read -r -p '启用严格模型白名单？[y/N]: ' strict; STRICT=false; yesno "$strict" && STRICT=true
read -r -p '启用 Fallback？[y/N]: ' fb
TEMP="$(mktemp "${TMPDIR:-/tmp}/gateway-reconfigure.XXXXXX.json")"; chmod 600 "$TEMP"
trap 'rm -f "$TEMP"; unset GATEWAY_ACCESS_KEY PRIMARY_API_TOKENS FALLBACK_API_TOKEN' EXIT
export GATEWAY_ACCESS_KEY PRIMARY_API_TOKENS PRIMARY_BASE_URL MODEL_MAPPING STRICT
if yesno "$fb"; then
  read -r -s -p 'FALLBACK_API_TOKEN: ' FALLBACK_API_TOKEN; echo
  read -r -p 'FALLBACK_BASE_URL: ' FALLBACK_BASE_URL
  read -r -p 'FALLBACK_PRIMARY_MODEL: ' FALLBACK_PRIMARY_MODEL
  read -r -p 'FALLBACK_SECONDARY_MODEL（留空或 off 关闭）: ' FALLBACK_SECONDARY_MODEL
  FALLBACK_SECONDARY_MODEL="${FALLBACK_SECONDARY_MODEL:-off}"
  FALLBACK_API_TOKEN="$FALLBACK_API_TOKEN" FALLBACK_BASE_URL="$FALLBACK_BASE_URL" \
    FALLBACK_PRIMARY_MODEL="$FALLBACK_PRIMARY_MODEL" FALLBACK_SECONDARY_MODEL="$FALLBACK_SECONDARY_MODEL" \
    node scripts/validate-fallback-config.mjs
  export FALLBACK_API_TOKEN FALLBACK_BASE_URL FALLBACK_PRIMARY_MODEL FALLBACK_SECONDARY_MODEL
  FB=true
else FB=false; fi
export FB
node - "$TEMP" <<'NODE'
import fs from 'node:fs';
const enabled=process.env.FB==='true';
const out={
 GATEWAY_ACCESS_KEY:process.env.GATEWAY_ACCESS_KEY,
 PRIMARY_API_TOKENS:process.env.PRIMARY_API_TOKENS,
 PRIMARY_BASE_URL:process.env.PRIMARY_BASE_URL||null,
 MODEL_MAPPING:process.env.MODEL_MAPPING||null,
 STRICT_MODEL_MAPPING:process.env.STRICT,
 FALLBACK_ENABLED:enabled?'true':'false',
 FALLBACK_SECONDARY_MODEL:enabled?(process.env.FALLBACK_SECONDARY_MODEL||'off'):'off',
 FALLBACK_API_TOKEN:enabled?process.env.FALLBACK_API_TOKEN:null,
 FALLBACK_BASE_URL:enabled?process.env.FALLBACK_BASE_URL:null,
 FALLBACK_PRIMARY_MODEL:enabled?process.env.FALLBACK_PRIMARY_MODEL:null,
 FALLBACK_PRIMARY_TOKEN:null,
 FALLBACK_PRIMARY_BASE_URL:null,
 FALLBACK_SECONDARY_TOKEN:null,
 FALLBACK_SECONDARY_BASE_URL:null
};
fs.writeFileSync(process.argv[2],JSON.stringify(out,null,2));
NODE
read -r -p '确认覆盖上述 Worker 的运行时配置？[y/N]: ' confirm
yesno "$confirm" || fail '已取消。'
npx --yes wrangler@4.114.0 secret bulk "$TEMP"
echo '配置已更新；请执行健康检查。'

