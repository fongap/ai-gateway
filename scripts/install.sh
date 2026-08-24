#!/bin/sh
# ai-gateway first-time install & deploy (new configuration schema).
set -e
cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required." >&2; exit 1; }
[ "$(node --version | sed 's/^v//' | cut -d. -f1)" -ge 20 ] || { echo "Node.js 20+ is required." >&2; exit 1; }

echo "==> Worker name"
DEFAULT_NAME="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("wrangler.jsonc","utf8")).name)')"
printf "Worker name [%s]: " "$DEFAULT_NAME"
read -r WORKER_NAME
WORKER_NAME="${WORKER_NAME:-$DEFAULT_NAME}"
node -e '
const fs = require("fs");
const name = process.argv[1];
if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) { console.error("invalid worker name"); process.exit(1); }
const c = JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8"));
c.name = name;
fs.writeFileSync("wrangler.jsonc", JSON.stringify(c, null, 2) + "\n");
' "$WORKER_NAME"

echo "==> Installing dependencies and verifying project"
npm ci
npm run verify

npx --yes wrangler@4.114.0 whoami || npx --yes wrangler@4.114.0 login

echo "==> Node configuration"
echo "Node configs are PLAIN variables without credentials; credentials go into a separate NODE_SECRETS file."
read -r -p "tier-1 node config JSON file: " TIER1
[ -n "$TIER1" ] && [ -f "$TIER1" ] || { echo "tier-1 file is required." >&2; exit 1; }
PLAN_ARGS="validate --tier1 $TIER1"
for N in 2 3; do
  read -r -p "tier-$N node config JSON file (optional, empty to skip): " TIER_FILE
  if [ -n "$TIER_FILE" ]; then
    [ -f "$TIER_FILE" ] || { echo "file not found: $TIER_FILE" >&2; exit 1; }
    PLAN_ARGS="$PLAN_ARGS --tier$N $TIER_FILE"
  fi
  eval "TIER$N=$TIER_FILE"
done
read -r -p "node secrets JSON file ({ \"node-id\": \"credential\" }): " SECRETS_FILE
[ -n "$SECRETS_FILE" ] && [ -f "$SECRETS_FILE" ] || { echo "secrets file is required." >&2; exit 1; }
PLAN_ARGS="$PLAN_ARGS --secrets $SECRETS_FILE"
# shellcheck disable=SC2086
node scripts/manage-nodes-config.mjs $PLAN_ARGS

echo "==> Sharding config into variables + secrets"
TMP_PLAN="$(mktemp)"
SHARD_ARGS="plan --secrets $SECRETS_FILE --out $TMP_PLAN"
[ -n "${TIER1:-}" ] && SHARD_ARGS="$SHARD_ARGS --tier1 $TIER1"
[ -n "${TIER2:-}" ] && SHARD_ARGS="$SHARD_ARGS --tier2 $TIER2"
[ -n "${TIER3:-}" ] && SHARD_ARGS="$SHARD_ARGS --tier3 $TIER3"
# shellcheck disable=SC2086
node scripts/manage-nodes-config.mjs $SHARD_ARGS

node -e '
const fs = require("fs");
const base = JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8"));
const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
base.vars = plan.vars;
fs.writeFileSync("wrangler.user.jsonc", JSON.stringify(base, null, 2) + "\n");
' "$TMP_PLAN"

printf "GATEWAY_ACCESS_KEY: "
stty -echo 2>/dev/null || true
read -r ACCESS_KEY
stty echo 2>/dev/null || true
echo ""
TMP_BULK="$(mktemp)"
GW_KEY="$ACCESS_KEY" node -e '
const fs = require("fs");
const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const bulk = { GATEWAY_ACCESS_KEY: process.env.GW_KEY, ...plan.secrets };
fs.writeFileSync(process.argv[2], JSON.stringify(bulk));
' "$TMP_PLAN" "$TMP_BULK"

npx --yes wrangler@4.114.0 deploy -c wrangler.user.jsonc --keep-vars
npx --yes wrangler@4.114.0 secret bulk "$TMP_BULK"
rm -f "$TMP_PLAN" "$TMP_BULK"

read -r -p "Gateway URL after deploy (empty to skip verification): " URL
if [ -n "$URL" ]; then
  case "$URL" in https://*) ;; *) echo "gateway URL must be https://" >&2; exit 1;; esac
  printf "GATEWAY_ACCESS_KEY again: "; stty -echo 2>/dev/null || true; read -r ACCESS; stty echo 2>/dev/null || true; echo ""
  curl -fsS "$URL/version" >/dev/null
  curl -fsS "$URL/health" -H "Authorization: Bearer $ACCESS" >/dev/null
  curl -fsS "$URL/v1/models" -H "Authorization: Bearer $ACCESS" >/dev/null
  echo "Deploy and online verification passed."
else
  echo "Deploy finished; online verification skipped."
fi
