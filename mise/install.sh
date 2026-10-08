#!/usr/bin/env zsh
#
# Install mise tools and activate shims for subsequent installers.

set -e

cd "$(dirname "$0")"/..

# Each topic's file reaches mise through a conf.d link, and install-symlinks
# lays those after this runs. Installing from inside each topic directory finds
# the file without its link, so a tool new to this run is on disk before a
# migration removes the Homebrew copy it replaces.
echo "› mise install"
for file in */mise.toml; do
  [ -f "$file" ] || continue
  mise trust "$file" --yes 2>/dev/null
  (cd "${file:h}" && mise install)
done

# A module declares bootstrap config and no tools, so it only needs trusting.
for file in */mise.*.toml(N); do
  mise trust "$file" --yes 2>/dev/null
done

# Activate mise shims so that installers can use any shell
eval "$(mise activate --shims)"
