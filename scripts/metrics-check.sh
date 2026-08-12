#!/usr/bin/env bash
set -euo pipefail
GATEWAY_URL="${1:-}"
if [[ -z "$GATEWAY_URL" ]]; then read -r -p "网关地址，例如 https://name.workers.dev: " GATEWAY_URL; fi
node - "$GATEWAY_URL" <<'NODE'
const raw=process.argv[2];
try{const u=new URL(raw);if(u.protocol!=='https:'||!u.hostname)throw new Error();}
catch{console.error('网关地址必须是完整 HTTPS URL，例如 https://name.account.workers.dev');process.exit(1);}
NODE
read -r -s -p "GATEWAY_ACCESS_KEY: " ACCESS_KEY; echo
curl --fail-with-body --silent --show-error "${GATEWAY_URL%/}/metrics" -H "Authorization: Bearer ${ACCESS_KEY}"
echo
unset ACCESS_KEY

