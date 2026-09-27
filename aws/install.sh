#!/usr/bin/env zsh
#
# vm is its own package so the repo root keeps no runtime dependencies,
# and the lockfile pins what lands here.

set -e

cd "${0:A:h}/vm"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun not found; skipping vm install" >&2
  exit 0
fi

bun install --frozen-lockfile --silent
