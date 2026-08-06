#!/usr/bin/env bash
set -euo pipefail
GATEWAY_URL="${1:-}"
if [[ -z "$GATEWAY_URL" ]]; then read -r -p "网关地址，例如 https://name.workers.dev: " GATEWAY_URL; fi
read -r -s -p "GATEWAY_ACCESS_KEY: " ACCESS_KEY; echo
curl --fail-with-body --silent --show-error \
  "${GATEWAY_URL%/}/metrics" \
  -H "Authorization: Bearer ${ACCESS_KEY}"
echo
unset ACCESS_KEY
