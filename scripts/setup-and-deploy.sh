#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

command -v node >/dev/null 2>&1 || { echo "未找到 Node.js 20+。" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "未找到 npm。" >&2; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || { echo "需要 Node.js 20 或更高版本。" >&2; exit 1; }

read -r -p "Worker 名称 [smart-edge-gateway]: " WORKER_NAME
WORKER_NAME="${WORKER_NAME:-smart-edge-gateway}"
[[ "$WORKER_NAME" =~ ^[a-z0-9-]+$ ]] || { echo "Worker 名称只能包含小写字母、数字和连字符。" >&2; exit 1; }

node - "$WORKER_NAME" <<'NODE'
import fs from 'node:fs';
const name = process.argv[2];
const path = 'wrangler.jsonc';
const content = fs.readFileSync(path, 'utf8').replace(/"name"\s*:\s*"[^"]+"/, `"name": "${name}"`);
fs.writeFileSync(path, content);
NODE

npm install
npm run verify

if ! npx wrangler whoami >/dev/null 2>&1; then
  npx wrangler login
fi

read -r -s -p "GATEWAY_ACCESS_KEY: " GATEWAY_ACCESS_KEY; echo
read -r -s -p "PRIMARY_API_TOKENS（支持 Token@BaseURL，多个用逗号分隔）: " PRIMARY_API_TOKENS; echo
read -r -p "PRIMARY_BASE_URL（Token 已绑定 URL 时留空）: " PRIMARY_BASE_URL
read -r -p "MODEL_MAPPING JSON 文件路径（不需要则留空）: " MODEL_MAPPING_PATH
read -r -p "配置 Fallback？[y/N]: " ENABLE_FALLBACK

MODEL_MAPPING=""
if [[ -n "$MODEL_MAPPING_PATH" ]]; then
  MODEL_MAPPING="$(cat "$MODEL_MAPPING_PATH")"
  MODEL_MAPPING="$MODEL_MAPPING" node -e 'JSON.parse(process.env.MODEL_MAPPING)'
fi

FALLBACK_API_TOKEN=""
FALLBACK_BASE_URL=""
FALLBACK_PRIMARY_MODEL=""
FALLBACK_SECONDARY_MODEL=""
FALLBACK_CLIENT_NOTICE_MODE=""
if [[ "$ENABLE_FALLBACK" =~ ^([yY]|[yY][eE][sS])$ ]]; then
  read -r -s -p "FALLBACK_API_TOKEN: " FALLBACK_API_TOKEN; echo
  read -r -p "FALLBACK_BASE_URL: " FALLBACK_BASE_URL
  read -r -p "FALLBACK_PRIMARY_MODEL: " FALLBACK_PRIMARY_MODEL
  read -r -p "FALLBACK_SECONDARY_MODEL（默认关闭；填写模型名启用）: " FALLBACK_SECONDARY_MODEL
  read -r -p "FALLBACK_CLIENT_NOTICE_MODE [headers]: " FALLBACK_CLIENT_NOTICE_MODE
  FALLBACK_CLIENT_NOTICE_MODE="${FALLBACK_CLIENT_NOTICE_MODE:-headers}"
fi

[[ -n "$GATEWAY_ACCESS_KEY" ]] || { echo "GATEWAY_ACCESS_KEY 不能为空。" >&2; exit 1; }
[[ -n "$PRIMARY_API_TOKENS" ]] || { echo "PRIMARY_API_TOKENS 不能为空。" >&2; exit 1; }
if [[ -z "$PRIMARY_BASE_URL" && ! "$PRIMARY_API_TOKENS" =~ @https?:// ]]; then
  echo "PRIMARY_API_TOKENS 未绑定 Base URL，必须填写 PRIMARY_BASE_URL。" >&2
  exit 1
fi

TEMP_FILE="$(mktemp "${TMPDIR:-/tmp}/smart-edge-gateway-secrets.XXXXXX.json")"
cleanup() {
  rm -f "$TEMP_FILE"
  unset GATEWAY_ACCESS_KEY PRIMARY_API_TOKENS PRIMARY_BASE_URL MODEL_MAPPING
  unset FALLBACK_API_TOKEN FALLBACK_BASE_URL FALLBACK_PRIMARY_MODEL FALLBACK_SECONDARY_MODEL FALLBACK_CLIENT_NOTICE_MODE
}
trap cleanup EXIT

export GATEWAY_ACCESS_KEY PRIMARY_API_TOKENS PRIMARY_BASE_URL MODEL_MAPPING
export FALLBACK_API_TOKEN FALLBACK_BASE_URL FALLBACK_PRIMARY_MODEL FALLBACK_SECONDARY_MODEL FALLBACK_CLIENT_NOTICE_MODE
node - "$TEMP_FILE" <<'NODE'
import fs from 'node:fs';
const output = process.argv[2];
const keys = [
  'GATEWAY_ACCESS_KEY', 'PRIMARY_API_TOKENS', 'PRIMARY_BASE_URL', 'MODEL_MAPPING',
  'FALLBACK_API_TOKEN', 'FALLBACK_BASE_URL', 'FALLBACK_PRIMARY_MODEL',
  'FALLBACK_SECONDARY_MODEL', 'FALLBACK_CLIENT_NOTICE_MODE'
];
const secrets = {};
for (const key of keys) {
  const value = process.env[key];
  if (value) secrets[key] = value;
}
fs.writeFileSync(output, JSON.stringify(secrets, null, 2));
NODE

npx wrangler deploy --secrets-file "$TEMP_FILE"
echo "部署完成。运行 ./scripts/health-check.sh 验证。"
