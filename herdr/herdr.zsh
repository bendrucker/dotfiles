#!/usr/bin/env zsh

# Keep the plugin declaration in this repo rather than herdr's plugin config
# dir, where it would sit next to a cache nobody wants to commit. herdr-lazy
# writes plugins.lock beside the list, which herdr/.gitignore drops.
export HERDR_LAZY_LIST="$ZSH/herdr/plugins.list"

# herdr-lazy has no binary on PATH: its plugin directory name carries an
# install-specific hash, so there is nothing stable to symlink.
herdr-lazy() {
  local root
  root=$(herdr plugin list --json |
    jq -r '.result.plugins[] | select(.plugin_id == "herdr-lazy") | .plugin_root') || return
  if [[ -z "$root" ]]; then
    echo "herdr-lazy is not installed" >&2
    return 1
  fi
  "$root/target/release/herdr-lazy" "$@"
}
