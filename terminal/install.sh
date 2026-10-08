#!/usr/bin/env sh

set -e

# The pinned catppuccin flavors are listed in package.toml.
if command -v ya >/dev/null 2>&1; then
  ya pkg install >/dev/null
fi
