#!/bin/sh
# Reconfigure an already-deployed worker using the current group-key schema.
# Delegates Cloudflare CLI actions to cloudflare-wrangler.mjs.
set -e
cd "$(dirname "$0")/.."

node scripts/cloudflare-wrangler.mjs whoami >/dev/null 2>&1 || { echo "login first: npm run cf:login" >&2; exit 1; }

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
TMP_ACCESS="$(mktemp)"
TMP_BULK="$(mktemp)"
trap 'rm -f "$EXISTING_VARS_FILE" "$TMP_PLAN" "$TMP_ACCESS" "$TMP_BULK"' EXIT INT TERM
PLAN_ARGS="$PLAN_ARGS --out $TMP_PLAN"
# shellcheck disable=SC2086
node scripts/plan-node-configuration.mjs $PLAN_ARGS
printf '{}\n' > "$TMP_ACCESS"

AFFINITY_KV_ID=""
if ! node -e '
const fs = require("fs");
const c = fs.existsSync("wrangler.user.jsonc") ? JSON.parse(fs.readFileSync("wrangler.user.jsonc", "utf8")) : {};
process.exit((c.kv_namespaces || []).some((entry) => entry.binding === "TIER1_AFFINITY" && /^[a-fA-F0-9]{32}$/.test(entry.id || "")) ? 0 : 1);
'; then
  printf "Tier 1 affinity KV namespace ID (required): "
  read -r AFFINITY_KV_ID
fi

echo "==> Gateway Access Groups"
echo "Leave a Group unchanged unless you explicitly choose to configure or rotate it."
for GROUP in AIR PRO MAX ULTRA AGENT; do
  printf "Configure/rotate %s? [y/N] " "$GROUP"
  read -r ROTATE
  if [ "$ROTATE" != "y" ] && [ "$ROTATE" != "Y" ]; then
    continue
  fi

  printf "new GATEWAY_ACCESS_KEY_%s: " "$GROUP"
  stty -echo 2>/dev/null || true
  read -r GROUP_KEY
  stty echo 2>/dev/null || true
  echo ""
  [ -n "$GROUP_KEY" ] || { echo "GATEWAY_ACCESS_KEY_$GROUP must not be empty when configuring this Group." >&2; exit 1; }

  printf "GATEWAY_ACCESS_MODELS_%s (CSV, required): " "$GROUP"
  read -r GROUP_MODELS
  if [ -z "$(printf '%s' "$GROUP_MODELS" | tr -d '[:space:]')" ]; then
    echo "GATEWAY_ACCESS_MODELS_$GROUP is required when GATEWAY_ACCESS_KEY_$GROUP is set." >&2
    exit 1
  fi

  GROUP_NAME="$GROUP" GROUP_KEY_VALUE="$GROUP_KEY" GROUP_MODELS_VALUE="$GROUP_MODELS" node -e '
const fs = require("fs");
const file = process.argv[1];
const value = JSON.parse(fs.readFileSync(file, "utf8"));
const group = process.env.GROUP_NAME;
value[`GATEWAY_ACCESS_KEY_${group}`] = process.env.GROUP_KEY_VALUE;
value[`GATEWAY_ACCESS_MODELS_${group}`] = process.env.GROUP_MODELS_VALUE;
fs.writeFileSync(file, JSON.stringify(value));
' "$TMP_ACCESS"
done

AFFINITY_KV_ID="$AFFINITY_KV_ID" node -e '
const fs = require("fs");
const base = fs.existsSync("wrangler.user.jsonc")
  ? JSON.parse(fs.readFileSync("wrangler.user.jsonc", "utf8"))
  : JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8"));
const previousVars = { ...(base.vars || {}) };
const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const access = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
base.vars = { ...plan.vars };
for (const [name, value] of Object.entries(previousVars)) {
  if (name.startsWith("GATEWAY_ACCESS_MODELS_")) base.vars[name] = value;
}
for (const [name, value] of Object.entries(access)) {
  if (name.startsWith("GATEWAY_ACCESS_MODELS_")) base.vars[name] = value;
}
if (!(base.kv_namespaces || []).some((entry) => entry.binding === "TIER1_AFFINITY")) {
  if (!/^[a-fA-F0-9]{32}$/.test(process.env.AFFINITY_KV_ID || "")) {
    console.error("Tier 1 affinity KV namespace ID must be 32 hexadecimal characters");
    process.exit(1);
  }
  base.kv_namespaces = [...(base.kv_namespaces || []), { binding: "TIER1_AFFINITY", id: process.env.AFFINITY_KV_ID }];
}
fs.writeFileSync("wrangler.user.jsonc", JSON.stringify(base, null, 2) + "\n");
' "$TMP_PLAN" "$TMP_ACCESS"

node -e '
const fs = require("fs");
const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const access = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const bulk = { ...plan.secrets };
for (const [name, value] of Object.entries(access)) {
  if (name.startsWith("GATEWAY_ACCESS_KEY_")) bulk[name] = value;
}
fs.writeFileSync(process.argv[3], JSON.stringify(bulk));
' "$TMP_PLAN" "$TMP_ACCESS" "$TMP_BULK"

node scripts/cloudflare-wrangler.mjs deploy -c wrangler.user.jsonc --keep-vars --secrets-file "$TMP_BULK"

node -e '
const plan = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const key of plan.deleteSecrets) console.log(key);
' "$TMP_PLAN" | while IFS= read -r KEY; do
  [ -n "$KEY" ] || continue
  echo "y" | node scripts/cloudflare-wrangler.mjs secret delete "$KEY" >/dev/null && echo "deleted stale secret: $KEY"
done

echo "Configuration updated."
