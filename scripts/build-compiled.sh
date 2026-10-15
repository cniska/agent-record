#!/usr/bin/env bash
set -euo pipefail

main() {
  local outfile="${1:?usage: build-compiled.sh <outfile>}"
  local root version
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  version="$(bun -e "console.log(require('$root/package.json').version)")"
  bun build --compile "$root/src/cli-release.ts" --outfile "$outfile" \
    --define "AGENT_RECORD_VERSION=\"$version\""
}

main "$@"
