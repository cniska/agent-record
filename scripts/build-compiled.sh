#!/usr/bin/env bash
set -euo pipefail

RELEASES_URL="https://api.github.com/repos/cniska/agent-record/releases/latest"

main() {
  local outfile="${1:?usage: build-compiled.sh <outfile> [<version>] [<releases-url>]}"
  local root version releases_url
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  version="${2:-$(bun -e "console.log(require('$root/package.json').version)")}"
  releases_url="${3:-$RELEASES_URL}"
  case "$version" in
    *[!0-9.]* | .* | *. | *..*) printf 'build-compiled: %s is not a version of the form x.y.z\n' "$version" >&2; exit 2 ;;
  esac
  bun build --compile "$root/src/cli-release.ts" --outfile "$outfile" \
    --define "AGENT_RECORD_VERSION=\"$version\"" \
    --define "AGENT_RECORD_RELEASES_URL=\"$releases_url\""
}

main "$@"
