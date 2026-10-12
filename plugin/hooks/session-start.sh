#!/bin/sh
set -eu
command -v agent-record >/dev/null 2>&1 || exit 0
nohup agent-record sync >/dev/null 2>&1 &
cat "$(dirname "$0")/note.md"
