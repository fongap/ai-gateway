#!/bin/sh
# One-shot: install + configure + deploy.
# Thin wrapper for compatibility.
set -e
cd "$(dirname "$0")/.."
sh scripts/install.sh