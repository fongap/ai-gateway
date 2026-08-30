#!/bin/sh
# Reconfigure an already-deployed worker (new schema, no legacy support).
set -e
cd "$(dirname "$0")/.."

npx --yes wrangler@4.114.0 whoami || { echo "login first: npm run cf:login" >&2; exit 1; }

read -r -p "tier-1 node config JSON file: " TIER1
[ -n "$TIER1" ] && [ -f "$TIER1" ] || { echo "tier-1 file is required." >&2; exit 1; }
PLAN_ARGS="plan --tier1 $TIER1"
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

# Existing managed var names from the local user config (if present).
EXISTING_VARS_FILE="$(mktemp)"
if [ -f wrangler.user.jsonc ]; then
  node -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync("wrangler.user.jsonc", "utf8"));
    fs.writeFileSync(process.argv[1], JSON.stringify(Object.keys(c.vars || {})));
  ' "$EXISTING_VARS_FILE"
else
  echo "[]" > "$EXISTING_VARS_FILE"
fi
PLAN_ARGS="$PLAN_ARGS --existing-vars $EXISTING_VARS_FILE"

TMP_PLAN="$(mktemp)"
PLAN_ARGS="$PLAN_ARGS --out $TMP_PLAN"
# shellcheck disable=SC2086
node scripts/plan-node-configuration.mjs $PLAN_ARGS

node -e '
const fs = require("fs");
const base = fs.existsSync("wrangler.user.jsonc")
  ? JSON.parse(fs.readFileSync("wrangler.user.jsonc", "utf8"))
  : JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8"));
const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
base.vars = plan.vars;
fs.writeFileSync("wrangler.user.jsonc", JSON.stringify(base, null, 2) + "\n");
' "$TMP_PLAN"

printf "Rotate GATEWAY_ACCESS_KEY? [y/N] "
read -r ROTATE
BULK_ARGS=""
if [ "$ROTATE" = "y" ] || [ "$ROTATE" = "Y" ]; then
  printf "new GATEWAY_ACCESS_KEY: "
  stty -echo 2>/dev/null || true; read -r ACCESS_KEY; stty echo 2>/dev/null || true; echo ""
  BULK_ARGS="$ACCESS_KEY"
fi

TMP_BULK="$(mktemp)"
GW_KEY="$BULK_ARGS" node -e '
const fs = require("fs");
const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const bulk = { ...plan.secrets };
if (process.env.GW_KEY) bulk.GATEWAY_ACCESS_KEY = process.env.GW_KEY;
fs.writeFileSync(process.argv[2], JSON.stringify(bulk));
' "$TMP_PLAN" "$TMP_BULK"

npx --yes wrangler@4.114.0 deploy -c wrangler.user.jsonc --keep-vars
npx --yes wrangler@4.114.0 secret bulk "$TMP_BULK"

node -e '
const plan = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const key of plan.deleteSecrets) console.log(key);
' "$TMP_PLAN" | while IFS= read -r KEY; do
  [ -n "$KEY" ] || continue
  echo "y" | npx --yes wrangler@4.114.0 secret delete "$KEY" >/dev/null && echo "deleted stale secret: $KEY"
done

rm -f "$EXISTING_VARS_FILE" "$TMP_PLAN" "$TMP_BULK"
echo "Configuration updated."
