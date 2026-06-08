#!/usr/bin/env sh

# silence the login prompt
touch "$HOME/.hushlogin"

# btop: seed btop.conf if missing. The active flavor is reconciled by the
# theme-sync pass that runs once all installers have created their configs.
btop_conf_dir="${XDG_CONFIG_HOME:-$HOME/.config}/btop"
btop_conf="$btop_conf_dir/btop.conf"
mkdir -p "$btop_conf_dir"
if [ ! -f "$btop_conf" ]; then
  btop --default-config > "$btop_conf"
fi
