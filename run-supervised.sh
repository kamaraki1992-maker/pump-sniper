#!/usr/bin/env bash
# Restarts the paper process. Immediate crashes back off; npm ci failure does not loop.
set -u
script_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$script_dir"
export PAPER_SUPERVISED=1

read -r -a delays <<< "${PAPER_SUPERVISOR_DELAYS:-10 30 60}"
max_tries="${PAPER_SUPERVISOR_MAX:-5}"
immediate_sec="${PAPER_SUPERVISOR_IMMEDIATE_SEC:-15}"
cmd="${START_CMD:-$script_dir/start-paper.sh}"

tries=0
while (( tries < max_tries )); do
  started=$(date +%s)
  set +e
  # shellcheck disable=SC2086
  $cmd "$@"
  code=$?
  set -e
  if (( code == 0 )); then
    exit 0
  fi
  if (( code == 2 )); then
    echo "supervisor: npm ci failed; not restarting" >&2
    exit 2
  fi
  now=$(date +%s)
  elapsed=$((now - started))
  if (( elapsed >= immediate_sec )); then
    tries=0
  fi
  tries=$((tries + 1))
  if (( tries >= max_tries )); then
    echo "supervisor giving up after ${tries} immediate exits (last code ${code})" >&2
    exit "$code"
  fi
  index=$((tries - 1))
  if (( index >= ${#delays[@]} )); then
    index=$((${#delays[@]} - 1))
  fi
  delay="${delays[$index]}"
  echo "supervisor exit ${code} after ${elapsed}s; retry ${tries} in ${delay}s" >&2
  sleep "$delay"
done
exit 1
