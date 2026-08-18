# shellcheck shell=bash
# Serializes anything that re-sources tmux's appearance configs.
#
# tmux interleaves commands from concurrent clients, so two overlapping
# re-sources corrupt state: the catppuccin plugin assembles the window formats
# with a chain of appends, and status.conf's capture can grab another run's
# wrapper, which renders every window tab as an empty string. A retheme
# (theme/bin/theme-sync-tmux) and a full config reload (tmux/reload.sh) both do
# that, so both take this lock. Route any new trigger through one of them.

TMUX_SOURCE_LOCK="${XDG_CACHE_HOME:-$HOME/.cache}/dotfiles/theme-sync-tmux.lock"

# mkdir is the portable atomic lock. Either operation takes well under a
# second, so a holder that outlives the wait is dead or wedged. Steal its lock.
# Returns nonzero only when even the steal fails.
tmux_source_lock_acquire() {
  mkdir -p "$(dirname "$TMUX_SOURCE_LOCK")"

  local _
  for _ in $(seq 1 100); do
    mkdir "$TMUX_SOURCE_LOCK" 2>/dev/null && return 0
    sleep 0.1
  done

  rmdir "$TMUX_SOURCE_LOCK" 2>/dev/null || true
  mkdir "$TMUX_SOURCE_LOCK" 2>/dev/null
}

tmux_source_lock_release() {
  rmdir "$TMUX_SOURCE_LOCK" 2>/dev/null || true
}
