#!/usr/bin/env zsh
#
# Install mise tools and activate shims for subsequent installers.

set -e

cd "$(dirname "$0")"/..

for file in */mise.toml; do
  [ -f "$file" ] || continue
  mise trust "$file" --yes 2>/dev/null
done

echo "› mise install"
mise install

# Activate mise shims so that installers can use any shell
eval "$(mise activate --shims)"
