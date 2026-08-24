#!/bin/sh
# One-shot: install + configure + deploy.
set -e
cd "$(dirname "$0")/.."
sh scripts/install.sh
