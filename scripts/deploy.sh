#!/bin/sh
# Code-only deploy; keeps remote vars and secrets untouched.
# Applies remote D1 migrations when the operator config has a TOKEN_STATS_DB
# binding, then deploys the Worker. Migration failures abort before deploy.
# Delegates to cloudflare-wrangler.mjs for all business logic.
set -e
cd "$(dirname "$0")/.."
exec node scripts/cloudflare-wrangler.mjs deploy --keep-vars "$@"