#!/usr/bin/env bash
# Paper entry. Installs dependencies once, then runs under the supervisor.
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
root="${PAPER_ROOT:-$script_dir}"
cd "$root"

if [[ ! -f "$root/node_modules/dotenv/package.json" ]]; then
  echo "node_modules missing dotenv; running npm ci" >&2
  if ! npm ci --prefix "$root"; then
    echo "npm ci failed" >&2
    exit 2
  fi
fi

if [[ "${PAPER_SUPERVISED:-}" != "1" ]]; then
  export PAPER_SUPERVISED=1
  exec "$script_dir/run-supervised.sh" "$@"
fi

exec npm start -- "$@"
