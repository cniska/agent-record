#!/bin/sh
set -eu

BASELINE_BIN="__BASELINE_BIN__"
BASELINE_VERSION="__BASELINE_VERSION__"

absolute_self() {
  case "$0" in
    /*) printf '%s\n' "$0" ;;
    *) printf '%s/%s\n' "$(cd "$(dirname "$0")" && pwd)" "$(basename "$0")" ;;
  esac
}

case "$BASELINE_BIN" in
  /*)
    AGENT_RECORD_LAUNCHER="$(absolute_self)"
    ;;
  *)
    BASELINE_BIN="${AGENT_RECORD_BASELINE_BIN:-}"
    BASELINE_VERSION="${AGENT_RECORD_BASELINE_VERSION:-}"
    AGENT_RECORD_LAUNCHER="${AGENT_RECORD_LAUNCHER:-$(absolute_self)}"
    ;;
esac
export AGENT_RECORD_LAUNCHER

data_home="${XDG_DATA_HOME:-}"
case "$data_home" in
  /*) ;;
  *) data_home="${HOME:-}/.local/share" ;;
esac
staged_dir="${data_home}/agent-record/bin"

version_max() {
  printf '%s\n%s\n' "$1" "$2" | awk -F. '
    { v[NR] = $0; for (i = 1; i <= 3; i++) f[NR, i] = $i + 0 }
    END {
      for (i = 1; i <= 3; i++) {
        if (f[1, i] > f[2, i]) { print v[1]; exit }
        if (f[1, i] < f[2, i]) { print v[2]; exit }
      }
      print v[1]
    }
  '
}

target="$BASELINE_BIN"
target_version="$BASELINE_VERSION"

for candidate in "$staged_dir"/*/agent-record; do
  if [ -x "$candidate" ]; then
    candidate_version="$(basename "$(dirname "$candidate")")"
    if [ "$(version_max "$target_version" "$candidate_version")" != "$target_version" ]; then
      target="$candidate"
      target_version="$candidate_version"
    fi
  fi
done

if [ ! -x "$target" ]; then
  printf '{"command":"agent-record","ok":false,"error":{"kind":"refusal","code":"binary_missing","message":"no runnable agent-record binary at %s","meta":{},"resolve":"reinstall agent-record"}}\n' "$target" >&2
  exit 1
fi

exec "$target" "$@"
