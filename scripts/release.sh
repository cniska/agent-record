#!/usr/bin/env bash
set -euo pipefail

die() {
  printf 'release: %s\n' "$1" >&2
  exit 1
}

next_version() {
  local level="$1" current="$2" major minor patch
  IFS=. read -r major minor patch <<<"$current"
  case "$level" in
    patch) printf '%s.%s.%s\n' "$major" "$minor" "$((patch + 1))" ;;
    minor) printf '%s.%s.0\n' "$major" "$((minor + 1))" ;;
    major) printf '%s.0.0\n' "$((major + 1))" ;;
  esac
}

main() {
  local level="${1:-}"
  case "$level" in
    patch | minor | major) ;;
    *) die "usage: scripts/release.sh <patch|minor|major>" ;;
  esac
  [ "$(git branch --show-current)" = "main" ] || die "release from main"
  [ -z "$(git status --porcelain)" ] || die "the working tree is not clean"

  local current next
  current="$(bun -e 'console.log(require("./package.json").version)')"
  next="$(next_version "$level" "$current")"
  bun -e "const p = require('./package.json'); p.version = '$next'; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n')"
  bun scripts/release-check.ts "v$next" || {
    git checkout -- package.json
    die "v$next is not a valid release; package.json is unchanged"
  }
  bun run check || {
    git checkout -- package.json
    die "the check failed on v$next; package.json is unchanged"
  }

  git add package.json
  git commit -m "chore: release v$next"
  git tag -m "v$next" "v$next"
  printf 'Tagged v%s. Push it to release:\n  git push origin main && git push origin v%s\n' "$next" "$next"
}

main "$@"
