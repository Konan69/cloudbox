#!/usr/bin/env bash
set -euo pipefail

if [[ ! -x /usr/bin/shellcheck ]]; then
  echo "error: /usr/bin/shellcheck is required; install it with: sudo apt-get install shellcheck" >&2
  exit 1
fi

script="$(mktemp --suffix=.cloudbox-bootstrap.sh)"
trap 'rm -f "$script"' EXIT
pnpm exec tsx scripts/render-bootstrap.ts "$script"
bash -n "$script"
/usr/bin/shellcheck --severity=warning "$script"
echo "bootstrap static checks passed: bash -n, shellcheck --severity=warning"
