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

root="$(cd "$(dirname "$0")/.." && pwd)"

command -v tmux >/dev/null 2>&1 || exit 0

# No server, so nothing is holding the old config. The next one reads it fresh.
tmux list-sessions >/dev/null 2>&1 || exit 0

# Re-sourcing tmux.conf re-runs TPM, which re-runs continuum's entrypoint, and
# that restores the entire saved session set whenever the server started under
# @continuum-restore-max-delay seconds ago. Sourcing inside that window
# resurrects saved sessions into a live server and re-runs @resurrect-processes
# in their panes. Wait it out instead. The server read the current config at
# startup, so all this delays is a change that landed in the seconds since.
started=$(tmux display-message -p -F '#{start_time}' 2>/dev/null || echo "")
window=$(tmux show -gv @continuum-restore-max-delay 2>/dev/null || echo 10)
[[ "$window" =~ ^[0-9]+$ ]] || window=10
# continuum reads an unreadable start time as a just-started server and
# restores on it, so match that reading rather than sourcing into it.
[[ "$started" =~ ^[0-9]+$ ]] || exit 0

remaining=$(( window - ($(date +%s) - started) + 1 ))
if (( remaining > 0 )); then
  # A window widened past the minute the dispatcher allows each reload isn't
  # worth waiting out, and the server is still on config it read moments ago.
  (( remaining > 30 )) && exit 0
  sleep "$remaining"
fi

# shellcheck source=../scripts/lib/tmux-source-lock.sh
source "$root/scripts/lib/tmux-source-lock.sh"

tmux_source_lock_acquire || exit 1

# tmux.conf ends by running theme-sync-tmux, which takes the same lock. The
# option tells it to stand down for the duration rather than wait out the
# timeout and steal a lock still in use. It carries this process's pid rather
# than a bare flag: a reload killed before its trap runs would otherwise leave
# the option set for the life of the server, silently ending every later theme
# flip. A pid that is gone reads as no reload in progress.
release() {
  tmux set -gu @tmux_config_reloading 2>/dev/null
  tmux_source_lock_release
}
trap release EXIT

tmux set -g @tmux_config_reloading $$
tmux source-file "${XDG_CONFIG_HOME:-$HOME/.config}/tmux/tmux.conf"
rc=$?

release
trap - EXIT

# A flavor flip that fired inside the window above found a reload in progress
# and stood down, and nothing would retry it. Re-run it now the lock is free.
# It re-reads the system appearance and no-ops when the server already agrees,
# so this costs nothing on the ordinary path.
"$root/theme/bin/theme-sync-tmux" || true

exit "$rc"
