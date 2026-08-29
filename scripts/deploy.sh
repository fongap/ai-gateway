#!/bin/sh
# Code-only deploy; keeps remote vars and secrets untouched.
# Applies remote D1 migrations when the operator config has a TOKEN_STATS_DB
# binding, then deploys the Worker. Migration failures abort before deploy.
set -e
cd "$(dirname "$0")/.."
WRANGLER="npx --yes wrangler@4.114.0"

apply_d1_migrations() {
  if [ ! -f wrangler.user.jsonc ]; then
    echo "skip: no wrangler.user.jsonc (no D1 binding to migrate)"
    return 0
  fi
  if ! node -e "const c=JSON.parse(require('fs').readFileSync('wrangler.user.jsonc','utf8'));const d=(c.d1_databases||[]).find(b=>b.binding==='TOKEN_STATS_DB');if(!d)process.exit(1)" 2>/dev/null; then
    echo "skip: no TOKEN_STATS_DB binding in wrangler.user.jsonc"
    return 0
  fi
  DB_NAME=$(node -e "const c=JSON.parse(require('fs').readFileSync('wrangler.user.jsonc','utf8'));const d=(c.d1_databases||[]).find(b=>b.binding==='TOKEN_STATS_DB');process.stdout.write(d.database_name||'')")
  echo "applying D1 migrations to '$DB_NAME' (remote)..."
  $WRANGLER d1 migrations apply "$DB_NAME" --remote -c wrangler.user.jsonc
}

if [ -f wrangler.user.jsonc ]; then
  apply_d1_migrations
  $WRANGLER deploy -c wrangler.user.jsonc --keep-vars
else
  $WRANGLER deploy --keep-vars
fi
