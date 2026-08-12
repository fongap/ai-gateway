#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
WRANGLER=(npx --yes wrangler@4.114.0)
fail(){ echo "错误：$*" >&2; exit 1; }
yesno(){ [[ "${1:-}" =~ ^([yY]|[yY][eE][sS])$ ]]; }
command -v node >/dev/null 2>&1 || fail "未找到 Node.js 20+。"
command -v npm >/dev/null 2>&1 || fail "未找到 npm。"
[[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 20 ]] || fail "需要 Node.js 20 或更高版本。"

DEFAULT_WORKER_NAME="$(node -p "JSON.parse(require('fs').readFileSync('wrangler.jsonc','utf8')).name")"
read -r -p "Worker 名称 [${DEFAULT_WORKER_NAME}]: " WORKER_NAME
WORKER_NAME="${WORKER_NAME:-$DEFAULT_WORKER_NAME}"
[[ "$WORKER_NAME" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail "Worker 名称必须为 1-63 位小写字母、数字或连字符，且不能以连字符开头或结尾。"
node - "$WORKER_NAME" <<'NODE'
import fs from 'node:fs';
const path='wrangler.jsonc'; const config=JSON.parse(fs.readFileSync(path,'utf8'));
config.name=process.argv[2]; fs.writeFileSync(path,JSON.stringify(config,null,2)+'\n');
NODE

npm ci
npm run verify
npm run check:deploy
if ! "${WRANGLER[@]}" whoami >/dev/null 2>&1; then "${WRANGLER[@]}" login; fi
"${WRANGLER[@]}" whoami

read -r -s -p "GATEWAY_ACCESS_KEY: " GATEWAY_ACCESS_KEY; echo
read -r -s -p "PRIMARY_API_TOKENS（Token@https://BaseURL，多个用逗号分隔）: " PRIMARY_API_TOKENS; echo
read -r -p "PRIMARY_BASE_URL（Token 已绑定 URL 时留空）: " PRIMARY_BASE_URL
[[ -n "$GATEWAY_ACCESS_KEY" ]] || fail "GATEWAY_ACCESS_KEY 不能为空。"
[[ -n "$PRIMARY_API_TOKENS" ]] || fail "PRIMARY_API_TOKENS 不能为空。"
PRIMARY_API_TOKENS="$PRIMARY_API_TOKENS" PRIMARY_BASE_URL="$PRIMARY_BASE_URL" node scripts/validate-primary-config.mjs

read -r -p "MODEL_MAPPING JSON 文件路径（不需要则留空）: " MODEL_MAPPING_PATH
MODEL_MAPPING=""
if [[ -n "$MODEL_MAPPING_PATH" ]]; then
  [[ -f "$MODEL_MAPPING_PATH" ]] || fail "MODEL_MAPPING 文件不存在。"
  node scripts/validate-model-mapping.mjs "$MODEL_MAPPING_PATH"
  MODEL_MAPPING="$(cat "$MODEL_MAPPING_PATH")"
fi
read -r -p "启用严格模型白名单？[y/N]: " STRICT_INPUT
STRICT_MODEL_MAPPING=false; yesno "$STRICT_INPUT" && STRICT_MODEL_MAPPING=true

FALLBACK_ENABLED=false
FALLBACK_API_TOKEN=""
FALLBACK_BASE_URL=""
FALLBACK_PRIMARY_MODEL=""
FALLBACK_SECONDARY_MODEL=off
read -r -p "配置 Fallback？[y/N]: " FALLBACK_INPUT
if yesno "$FALLBACK_INPUT"; then
  FALLBACK_ENABLED=true
  read -r -s -p "FALLBACK_API_TOKEN: " FALLBACK_API_TOKEN; echo
  read -r -p "FALLBACK_BASE_URL: " FALLBACK_BASE_URL
  read -r -p "FALLBACK_PRIMARY_MODEL: " FALLBACK_PRIMARY_MODEL
  read -r -p "FALLBACK_SECONDARY_MODEL（留空或 off 关闭）: " SECONDARY
  FALLBACK_SECONDARY_MODEL="${SECONDARY:-off}"
  FALLBACK_API_TOKEN="$FALLBACK_API_TOKEN" FALLBACK_BASE_URL="$FALLBACK_BASE_URL" \
    FALLBACK_PRIMARY_MODEL="$FALLBACK_PRIMARY_MODEL" FALLBACK_SECONDARY_MODEL="$FALLBACK_SECONDARY_MODEL" \
    node scripts/validate-fallback-config.mjs
fi

TEMP="$(mktemp "${TMPDIR:-/tmp}/gateway-install.XXXXXX.json")"
chmod 600 "$TEMP"
cleanup(){ rm -f "$TEMP"; unset GATEWAY_ACCESS_KEY PRIMARY_API_TOKENS FALLBACK_API_TOKEN; }
trap cleanup EXIT
export GATEWAY_ACCESS_KEY PRIMARY_API_TOKENS PRIMARY_BASE_URL MODEL_MAPPING STRICT_MODEL_MAPPING
export FALLBACK_ENABLED FALLBACK_API_TOKEN FALLBACK_BASE_URL FALLBACK_PRIMARY_MODEL FALLBACK_SECONDARY_MODEL
node - "$TEMP" <<'NODE'
import fs from 'node:fs';
const out={
  GATEWAY_ACCESS_KEY:process.env.GATEWAY_ACCESS_KEY,
  PRIMARY_API_TOKENS:process.env.PRIMARY_API_TOKENS,
  PRIMARY_BASE_URL:process.env.PRIMARY_BASE_URL||'',
  MODEL_MAPPING:process.env.MODEL_MAPPING||'',
  STRICT_MODEL_MAPPING:process.env.STRICT_MODEL_MAPPING,
  FALLBACK_ENABLED:process.env.FALLBACK_ENABLED,
  FALLBACK_SECONDARY_MODEL:process.env.FALLBACK_SECONDARY_MODEL||'off',
  FALLBACK_CLIENT_NOTICE_MODE:'headers',
  FAKE_STREAM_PROTECTION:'false',
  ALLOW_UNSAFE_PROXY_ROUTES:'false',
  ALLOW_INSECURE_HTTP_UPSTREAM:'false',
  EXPOSE_UPSTREAM_INFO:'false'
};
if(process.env.FALLBACK_ENABLED==='true') Object.assign(out,{
  FALLBACK_API_TOKEN:process.env.FALLBACK_API_TOKEN,
  FALLBACK_BASE_URL:process.env.FALLBACK_BASE_URL,
  FALLBACK_PRIMARY_MODEL:process.env.FALLBACK_PRIMARY_MODEL
});
fs.writeFileSync(process.argv[2],JSON.stringify(out,null,2));
NODE

echo "将首次部署 Worker：$WORKER_NAME"
read -r -p "确认继续？[y/N]: " CONFIRM
yesno "$CONFIRM" || fail "已取消。"
"${WRANGLER[@]}" deploy --keep-vars --secrets-file "$TEMP"

read -r -p "部署后的网关 URL（例如 https://example.workers.dev；留空跳过验证）: " GATEWAY_URL
if [[ -n "$GATEWAY_URL" ]]; then
  [[ "$GATEWAY_URL" =~ ^https://[^[:space:]]+$ ]] || fail "网关 URL 必须是完整 HTTPS 地址。"
  curl -fsS "${GATEWAY_URL%/}/version" >/dev/null || fail "/version 验证失败。"
  curl -fsS "${GATEWAY_URL%/}/health" -H "Authorization: Bearer $GATEWAY_ACCESS_KEY" >/dev/null || fail "/health 验证失败。"
  curl -fsS "${GATEWAY_URL%/}/v1/models" -H "Authorization: Bearer $GATEWAY_ACCESS_KEY" >/dev/null || fail "/v1/models 验证失败。"
  echo "部署和运行验证均通过。"
else
  echo "部署完成；尚未执行线上健康检查。"
fi

