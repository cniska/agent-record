#!/usr/bin/env bash
set -euo pipefail

main() {
  local outfile="${1:?usage: build-compiled.sh <outfile> [<version>]}"
  local root version
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  version="${2:-$(bun -e "console.log(require('$root/package.json').version)")}"
  case "$version" in
    *[!0-9.]* | .* | *. | *..*) printf 'build-compiled: %s is not a version of the form x.y.z\n' "$version" >&2; exit 2 ;;
  esac
  bun build --compile "$root/src/cli-release.ts" --outfile "$outfile" \
    --define "AGENT_RECORD_VERSION=\"$version\""
}

main "$@"
