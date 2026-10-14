#!/bin/sh
set -eu

mise trust --quiet
mise install
bun install --frozen-lockfile
