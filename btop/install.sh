#!/usr/bin/env bash
# Seed btop.conf if missing and apply the catppuccin flavor.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"

conf_dir="${XDG_CONFIG_HOME:-$HOME/.config}/btop"
conf="$conf_dir/btop.conf"

mkdir -p "$conf_dir"
if [[ ! -f "$conf" ]]; then
  btop --default-config > "$conf"
fi

"$script_dir/../theme/bin/theme-sync-btop"
