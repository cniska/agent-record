#!/usr/bin/env bash
set -euo pipefail

main() {
  local outfile="${1:?usage: build-compiled.sh <outfile>}"
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  bun build --compile "$root/src/cli-release.ts" --outfile "$outfile"
}

main "$@"
