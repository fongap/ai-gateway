#!/bin/sh
# Pull latest code, verify, redeploy. Keeps remote vars/secrets untouched.
set -e
cd "$(dirname "$0")/.."
git pull --ff-only
npm ci
npm run verify
sh scripts/deploy.sh
