#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
npm ci
npm run verify
npm run check:deploy
npx --yes wrangler@4.114.0 whoami
WORKER_NAME="$(node -p "JSON.parse(require('fs').readFileSync('wrangler.jsonc','utf8')).name")"
printf '%s\n' "目标 Worker：${WORKER_NAME}"
printf '%s\n' '安全更新只部署代码，并使用 keep_vars 保留控制台变量和现有 Secret。'
read -r -p '确认更新当前 Worker？[y/N]: ' answer
[[ "$answer" =~ ^([yY]|[yY][eE][sS])$ ]] || { echo '已取消。'; exit 1; }
npx --yes wrangler@4.114.0 deploy --keep-vars
echo '代码更新完成。请运行 health-check.sh 与 models-check.sh 验证。'
