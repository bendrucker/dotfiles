#!/usr/bin/env sh

# silence the login prompt
touch "$HOME/.hushlogin"

# btop: seed btop.conf if missing, then apply the active catppuccin flavor.
script_dir="$(cd "$(dirname "$0")" && pwd)"
btop_conf_dir="${XDG_CONFIG_HOME:-$HOME/.config}/btop"
btop_conf="$btop_conf_dir/btop.conf"
mkdir -p "$btop_conf_dir"
if [ ! -f "$btop_conf" ]; then
  btop --default-config > "$btop_conf"
fi
"$script_dir/../theme/bin/theme-sync-btop"
