#!/bin/sh
# Code-only deploy; keeps remote vars and secrets untouched.
set -e
cd "$(dirname "$0")/.."
if [ -f wrangler.user.jsonc ]; then
  npx --yes wrangler@4.114.0 deploy -c wrangler.user.jsonc --keep-vars
else
  npx --yes wrangler@4.114.0 deploy --keep-vars
fi
