#!/bin/sh
# ai-gateway first-time install & deploy (current configuration schema).
set -e
cd "$(dirname "$0")/.."

# Node.js version contract: single source of truth is package.json -> engines.node
# Reuse version-check.mjs logic for consistent semver validation.
if ! node scripts/version-check.mjs 2>/dev/null; then
  echo "Node.js version check failed. Required: $(node -e 'console.log(require("./package.json").engines.node)')" >&2
  exit 1
fi

echo "==> Worker name"
DEFAULT_NAME="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("wrangler.jsonc","utf8")).name)')"
printf "Worker name [%s]: " "$DEFAULT_NAME"
read -r WORKER_NAME
WORKER_NAME="${WORKER_NAME:-$DEFAULT_NAME}"
printf "Tier 1 affinity KV namespace ID (required): "
read -r AFFINITY_KV_ID
node -e '
const fs = require("fs");
const name = process.argv[1];
if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) { console.error("invalid worker name"); process.exit(1); }
if (!/^[a-fA-F0-9]{32}$/.test(process.argv[2])) { console.error("Tier 1 affinity KV namespace ID must be 32 hexadecimal characters"); process.exit(1); }
const c = JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8"));
c.name = name;
fs.writeFileSync("wrangler.jsonc", JSON.stringify(c, null, 2) + "\n");
' "$WORKER_NAME" "$AFFINITY_KV_ID"

echo "==> Installing dependencies and verifying project"
npm ci
npm run validate:merge

# Cloudflare login: whoami -> login (only if not logged in)
npx --yes wrangler@4.114.0 whoami >/dev/null 2>&1 || npx --yes wrangler@4.114.0 login

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
node scripts/plan-node-configuration.mjs $PLAN_ARGS

echo "==> Sharding config into variables + secrets"
TMP_PLAN="$(mktemp)"
TMP_ACCESS="$(mktemp)"
TMP_BULK="$(mktemp)"
trap 'rm -f "$TMP_PLAN" "$TMP_ACCESS" "$TMP_BULK"' EXIT INT TERM
SHARD_ARGS="plan --secrets $SECRETS_FILE --out $TMP_PLAN"
[ -n "${TIER1:-}" ] && SHARD_ARGS="$SHARD_ARGS --tier1 $TIER1"
[ -n "${TIER2:-}" ] && SHARD_ARGS="$SHARD_ARGS --tier2 $TIER2"
[ -n "${TIER3:-}" ] && SHARD_ARGS="$SHARD_ARGS --tier3 $TIER3"
# shellcheck disable=SC2086
node scripts/plan-node-configuration.mjs $SHARD_ARGS
printf '{}\n' > "$TMP_ACCESS"

echo "==> Gateway Access Groups"
echo "Configure at least one of AIR / PRO / MAX / ULTRA / AGENT. Empty Key skips that Group."
ACCESS_GROUP_COUNT=0
VERIFY_KEY=""
for GROUP in AIR PRO MAX ULTRA AGENT; do
  printf "GATEWAY_ACCESS_KEY_%s (empty to skip): " "$GROUP"
  stty -echo 2>/dev/null || true
  read -r GROUP_KEY
  stty echo 2>/dev/null || true
  echo ""
  [ -n "$GROUP_KEY" ] || continue

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

  ACCESS_GROUP_COUNT=$((ACCESS_GROUP_COUNT + 1))
  [ -n "$VERIFY_KEY" ] || VERIFY_KEY="$GROUP_KEY"
done

if [ "$ACCESS_GROUP_COUNT" -eq 0 ]; then
  echo "At least one Gateway Access Group Key must be configured (AIR, PRO, MAX, ULTRA, or AGENT)." >&2
  exit 1
fi

AFFINITY_KV_ID="$AFFINITY_KV_ID" node -e '
const fs = require("fs");
const base = JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8"));
const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const access = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
base.vars = { ...plan.vars };
for (const [name, value] of Object.entries(access)) {
  if (name.startsWith("GATEWAY_ACCESS_MODELS_")) base.vars[name] = value;
}
base.kv_namespaces = [{ binding: "TIER1_AFFINITY", id: process.env.AFFINITY_KV_ID }];
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

# Single deploy with secrets file — avoids code/secret two-phase deploy
npx --yes wrangler@4.114.0 deploy -c wrangler.user.jsonc --keep-vars --secrets-file "$TMP_BULK"

read -r -p "Gateway URL after deploy (empty to skip verification): " URL
if [ -n "$URL" ]; then
  case "$URL" in https://*) ;; *) echo "gateway URL must be https://" >&2; exit 1;; esac
  curl -fsS "$URL/version" >/dev/null
  curl -fsS "$URL/health" -H "Authorization: Bearer $VERIFY_KEY" >/dev/null
  curl -fsS "$URL/v1/models" -H "Authorization: Bearer $VERIFY_KEY" >/dev/null
  echo "Deploy and online verification passed."
else
  echo "Deploy finished; online verification skipped."
fi
