#!/usr/bin/env bash
set -euo pipefail

main() {
  local executable="${1:?usage: smoke.sh <executable> <version>}"
  local version="${2:?usage: smoke.sh <executable> <version>}"
  local scratch
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/agent-record-smoke.XXXXXX")"
  cd "$scratch"
  export HOME="$scratch/home"
  export XDG_DATA_HOME="$scratch/data"
  export XDG_STATE_HOME="$scratch/state"
  export AGENT_RECORD_MIRROR="$scratch/mirror"
  mkdir -p "$HOME"
  test "$("$executable" --version)" = "$version"
  "$executable" sync >/dev/null
  "$executable" doctor >/dev/null
}

main "$@"
