#!/bin/sh
set -eu

REPO="cniska/agent-record"
DOWNLOAD_TIMEOUT_SECONDS=300

die() {
  printf 'agent-record install: %s\n' "$1" >&2
  exit 1
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    sha256sum "$1" | cut -d ' ' -f 1
  fi
}

escape_replacement() {
  printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'
}

fetch_verified() {
  url="$1"
  sha_url="$2"
  dest="$3"
  curl -fsSL --max-time "$DOWNLOAD_TIMEOUT_SECONDS" "$url" -o "$dest" || die "could not download ${url}"
  curl -fsSL --max-time "$DOWNLOAD_TIMEOUT_SECONDS" "$sha_url" -o "${dest}.sha256" || die "could not download ${sha_url}"
  expected="$(cut -d ' ' -f 1 "${dest}.sha256")"
  actual="$(sha256_of "$dest")"
  [ "$expected" = "$actual" ] || die "checksum mismatch for ${url}: expected ${expected}, got ${actual}"
}

platform_target() {
  platform="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
  esac
  case "${platform}-${arch}" in
    darwin-arm64 | linux-x64) printf '%s-%s\n' "$platform" "$arch" ;;
    *) die "no release build for ${platform}-${arch}; build from source with Bun, as the README says" ;;
  esac
}

remove_leftovers() {
  if [ -f "${tmpdir}/partials" ]; then
    while IFS= read -r partial; do
      rm -f "$partial"
    done <"${tmpdir}/partials"
  fi
  rm -rf "$tmpdir"
}

install_file() {
  from="$1"
  dest="$2"
  partial="$(mktemp "$(dirname "$dest")/.agent-record.XXXXXX")" || die "could not write beside ${dest}"
  printf '%s\n' "$partial" >>"${tmpdir}/partials"
  cp "$from" "$partial" || die "could not write ${partial}"
  chmod 755 "$partial"
  mv -f "$partial" "$dest" || die "could not move ${partial} to ${dest}"
}

prune_other_builds() {
  for entry in "$lib_dir"/*; do
    if [ -e "$entry" ] && [ "$entry" != "$1" ]; then
      rm -rf "$entry"
    fi
  done
}

shell_config() {
  case "${SHELL:-}" in
    */zsh) printf '%s\n' "${HOME}/.zshrc" ;;
    */bash)
      if [ -f "${HOME}/.bashrc" ]; then
        printf '%s\n' "${HOME}/.bashrc"
      elif [ -f "${HOME}/.bash_profile" ]; then
        printf '%s\n' "${HOME}/.bash_profile"
      fi
      ;;
  esac
}

put_on_path() {
  install_dir="$1"
  if echo "$PATH" | tr ':' '\n' | grep -Fqx "$install_dir"; then
    return 0
  fi
  config="$(shell_config)"
  if [ -z "$config" ]; then
    echo "Add ${install_dir} to your PATH."
    return 0
  fi
  if ! grep -qF "$install_dir" "$config" 2>/dev/null; then
    printf '\nexport PATH="%s:%s"\n' "$install_dir" "\$PATH" >>"$config"
    echo "Added ${install_dir} to PATH in ${config}"
  fi
}

main() {
  [ -n "${HOME:-}" ] || die "HOME is not set, so there is no install directory"
  command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 ||
    die "neither shasum nor sha256sum is available to check the download"

  target="$(platform_target)"
  install_dir="${HOME}/.local/bin"
  lib_dir="${HOME}/.local/lib/agent-record"
  asset="agent-record-${target}.tar.gz"
  base_url="https://github.com/${REPO}/releases/latest/download"

  tmpdir="$(mktemp -d)"
  trap remove_leftovers EXIT

  echo "Downloading the latest agent-record for ${target}..."
  fetch_verified "${base_url}/${asset}" "${base_url}/agent-record-${target}.sha256" "${tmpdir}/${asset}"
  fetch_verified "${base_url}/launcher.sh" "${base_url}/launcher.sha256" "${tmpdir}/launcher.sh"

  tar -xzf "${tmpdir}/${asset}" -C "$tmpdir" agent-record || die "${asset} holds no agent-record binary"
  chmod +x "${tmpdir}/agent-record"
  version="$("${tmpdir}/agent-record" --version)" || die "the downloaded agent-record does not run on this machine"
  [ -n "$version" ] && [ "$(printf '%s\n' "$version" | grep -Ex '[0-9]+\.[0-9]+\.[0-9]+')" = "$version" ] ||
    die "the downloaded agent-record reports version '$(printf '%s' "$version" | tr '\n' ' ')', not x.y.z; this release is broken, so install a later one"
  build_dir="${lib_dir}/${version}"
  build="${build_dir}/agent-record"

  mkdir -p "$build_dir" "$install_dir"
  install_file "${tmpdir}/agent-record" "$build"
  sed -e "s|__BASELINE_BIN__|$(escape_replacement "$build")|" \
    -e "s|__BASELINE_VERSION__|$(escape_replacement "$version")|" \
    "${tmpdir}/launcher.sh" >"${tmpdir}/launcher"
  install_file "${tmpdir}/launcher" "${install_dir}/agent-record"
  prune_other_builds "$build_dir"

  put_on_path "$install_dir"
  echo "agent-record ${version} installed: ${install_dir}/agent-record runs ${build}."
  echo "Run 'agent-record sync' to build the record, then 'agent-record doctor'."
}

main
