#!/usr/bin/env bash
#
# Re-source the tmux config in the running server, the same thing prefix+r
# does. Sessions, panes, and the processes in them are untouched.
#
# The config is written to survive this: core/unbinds.conf tombstones removed
# bindings, since source-file cannot unbind a key by forgetting it, and
# responsive.conf and status.conf guard their captures so a second source is a
# no-op rather than a wrapper captured into itself.
set -uo pipefail

command -v tmux >/dev/null 2>&1 || exit 0

# No server, so nothing is holding the old config. The next one reads it fresh.
tmux list-sessions >/dev/null 2>&1 || exit 0

# shellcheck source=../scripts/lib/tmux-source-lock.sh
source "$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/tmux-source-lock.sh"

tmux_source_lock_acquire || exit 1

# tmux.conf ends by running theme-sync-tmux, which takes the same lock. The
# flag tells it to stand down for the duration rather than wait out the
# timeout and steal a lock still in use. Re-sourcing tmux.conf re-applies the
# flavor on its own, through the plugin: @catppuccin_flavor is set with -o, so
# the value theme-sync-tmux chose survives the reload.
release() {
  tmux set -gu @tmux_config_reloading 2>/dev/null
  tmux_source_lock_release
}
trap release EXIT

tmux set -g @tmux_config_reloading 1
tmux source-file "${XDG_CONFIG_HOME:-$HOME/.config}/tmux/tmux.conf"
