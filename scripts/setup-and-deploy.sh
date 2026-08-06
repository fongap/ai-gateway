#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
WRANGLER=(npx --yes wrangler@4.114.0)

fail(){ echo "错误：$*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || fail "未找到 Node.js 20+。"
command -v npm >/dev/null 2>&1 || fail "未找到 npm。"
[[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 20 ]] || fail "需要 Node.js 20 或更高版本。"

read -r -p "Worker 名称 [smart-edge-gateway]: " WORKER_NAME
WORKER_NAME="${WORKER_NAME:-smart-edge-gateway}"
node - "$WORKER_NAME" <<'NODE'
const name=process.argv[2];
if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)){
  console.error('Worker 名称必须为 1-63 位小写字母、数字或连字符，且不能以连字符开头或结尾。');
  process.exit(1);
}
NODE
node - "$WORKER_NAME" <<'NODE'
import fs from 'node:fs';
const path='wrangler.jsonc';
const data=JSON.parse(fs.readFileSync(path,'utf8'));
data.name=process.argv[2];
fs.writeFileSync(path,JSON.stringify(data,null,2)+'\n');
NODE

npm ci
npm run verify
npm run check:deploy
if ! "${WRANGLER[@]}" whoami >/dev/null 2>&1; then "${WRANGLER[@]}" login; fi

read -r -s -p "GATEWAY_ACCESS_KEY: " GATEWAY_ACCESS_KEY; echo
read -r -s -p "PRIMARY_API_TOKENS（Token@https://BaseURL，多个用逗号分隔）: " PRIMARY_API_TOKENS; echo
read -r -p "PRIMARY_BASE_URL（Token 已绑定 URL 时留空）: " PRIMARY_BASE_URL
read -r -p "MODEL_MAPPING JSON 文件路径（不需要则留空）: " MODEL_MAPPING_PATH
read -r -p "启用严格模型白名单？[y/N]: " STRICT_MAPPING_INPUT
read -r -p "配置 Fallback？[y/N]: " ENABLE_FALLBACK

[[ -n "$GATEWAY_ACCESS_KEY" ]] || fail "GATEWAY_ACCESS_KEY 不能为空。"
PRIMARY_API_TOKENS="$PRIMARY_API_TOKENS" PRIMARY_BASE_URL="$PRIMARY_BASE_URL" node scripts/validate-primary-config.mjs

MODEL_MAPPING=""
if [[ -n "$MODEL_MAPPING_PATH" ]]; then
  [[ -f "$MODEL_MAPPING_PATH" ]] || fail "MODEL_MAPPING 文件不存在。"
  MODEL_MAPPING="$(cat "$MODEL_MAPPING_PATH")"
  MODEL_MAPPING="$MODEL_MAPPING" node -e 'JSON.parse(process.env.MODEL_MAPPING)'
fi
STRICT_MODEL_MAPPING=false
[[ "$STRICT_MAPPING_INPUT" =~ ^([yY]|[yY][eE][sS])$ ]] && STRICT_MODEL_MAPPING=true

FALLBACK_ENABLED=false
FALLBACK_API_TOKEN=""
FALLBACK_BASE_URL=""
FALLBACK_PRIMARY_MODEL=""
FALLBACK_SECONDARY_MODEL=off
FALLBACK_CLIENT_NOTICE_MODE=headers
if [[ "$ENABLE_FALLBACK" =~ ^([yY]|[yY][eE][sS])$ ]]; then
  FALLBACK_ENABLED=true
  read -r -s -p "FALLBACK_API_TOKEN: " FALLBACK_API_TOKEN; echo
  read -r -p "FALLBACK_BASE_URL: " FALLBACK_BASE_URL
  read -r -p "FALLBACK_PRIMARY_MODEL: " FALLBACK_PRIMARY_MODEL
  read -r -p "FALLBACK_SECONDARY_MODEL（留空或 off 关闭）: " SECONDARY
  FALLBACK_SECONDARY_MODEL="${SECONDARY:-off}"
  [[ "$FALLBACK_BASE_URL" =~ ^https:// ]] || fail "FALLBACK_BASE_URL 必须使用 HTTPS。"
  [[ -n "$FALLBACK_API_TOKEN" && -n "$FALLBACK_PRIMARY_MODEL" ]] || fail "Fallback Token 和第一兜底模型不能为空。"
fi

TEMP_FILE="$(mktemp "${TMPDIR:-/tmp}/smart-edge-gateway-secrets.XXXXXX.json")"
cleanup(){ rm -f "$TEMP_FILE"; unset GATEWAY_ACCESS_KEY PRIMARY_API_TOKENS FALLBACK_API_TOKEN; }
trap cleanup EXIT

export GATEWAY_ACCESS_KEY PRIMARY_API_TOKENS PRIMARY_BASE_URL MODEL_MAPPING STRICT_MODEL_MAPPING
export FALLBACK_ENABLED FALLBACK_API_TOKEN FALLBACK_BASE_URL FALLBACK_PRIMARY_MODEL FALLBACK_SECONDARY_MODEL FALLBACK_CLIENT_NOTICE_MODE
node - "$TEMP_FILE" <<'NODE'
import fs from 'node:fs';
const keys=[
 'GATEWAY_ACCESS_KEY','PRIMARY_API_TOKENS','PRIMARY_BASE_URL','MODEL_MAPPING','STRICT_MODEL_MAPPING',
 'FALLBACK_ENABLED','FALLBACK_API_TOKEN','FALLBACK_BASE_URL','FALLBACK_PRIMARY_MODEL',
 'FALLBACK_SECONDARY_MODEL','FALLBACK_CLIENT_NOTICE_MODE'
];
const out={
  FAKE_STREAM_PROTECTION:'false',
  ALLOW_UNSAFE_PROXY_ROUTES:'false',
  ALLOW_INSECURE_HTTP_UPSTREAM:'false',
  EXPOSE_UPSTREAM_INFO:'false'
};
for(const key of keys){ const v=process.env[key]; if(v!==undefined && v!=='') out[key]=v; }
fs.writeFileSync(process.argv[2],JSON.stringify(out,null,2));
NODE

"${WRANGLER[@]}" deploy --keep-vars --secrets-file "$TEMP_FILE"
echo "部署完成。请用 scripts/health-check.sh、models-check.sh 验证实际域名。"
