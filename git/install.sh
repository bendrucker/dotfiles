#!/usr/bin/env bash
# Install delta's flavor selector as a real file at ~/.config/git/delta-flavor.conf
# rather than a symlink. theme-sync-delta rewrites the `features` line on
# light/dark switches; if this were symlinked, every switch would dirty the
# tracked copy.
set -euo pipefail

topic_dir="$(cd "$(dirname "$0")" && pwd)"

config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/git"
mkdir -p "$config_dir"
cp "$topic_dir/delta-flavor.conf" "$config_dir/delta-flavor.conf"
