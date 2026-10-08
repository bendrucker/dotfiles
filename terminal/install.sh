#!/usr/bin/env sh

set -e

# Yazi: install the pinned catppuccin flavors listed in package.toml into
# ~/.config/yazi/flavors/.
if command -v ya >/dev/null 2>&1; then
  ya pkg install >/dev/null
fi
