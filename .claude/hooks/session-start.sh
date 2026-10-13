#!/bin/sh
set -eu
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"
bun install --frozen-lockfile
