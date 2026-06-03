#!/usr/bin/env bash
# Install hunk's config as a real file at ~/.config/hunk/config.toml rather than
# a symlink. The theme sync scripts rewrite the `theme` line on light/dark
# switches; if this were symlinked, every switch would dirty the tracked copy.
set -euo pipefail

topic_dir="$(cd "$(dirname "$0")" && pwd)"
dotfiles_root="$(cd "$topic_dir/.." && pwd)"

config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/hunk"
mkdir -p "$config_dir"
cp "$topic_dir/config.toml" "$config_dir/config.toml"

# Reconcile the freshly copied default flavor with the active appearance.
"$dotfiles_root/theme/bin/theme-sync-hunk"
