#!/usr/bin/env bash
# Paper process. Installs dependencies once when node_modules is incomplete.
set -euo pipefail
root="${PAPER_ROOT:-$(cd "$(dirname "$0")" && pwd)}"
cd "$root"

if [[ ! -f "$root/node_modules/dotenv/package.json" ]]; then
  echo "node_modules missing dotenv; running npm ci" >&2
  if ! npm ci --prefix "$root"; then
    echo "npm ci failed" >&2
    exit 2
  fi
fi

exec npm start -- "$@"
