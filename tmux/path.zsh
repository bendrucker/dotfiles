#!/usr/bin/env zsh

# In path.zsh (sourced by zshenv) so non-interactive shells get it too.
export TMUX_TMPDIR="$HOME/.tmux"
[[ -d "$TMUX_TMPDIR" ]] || mkdir -p "$TMUX_TMPDIR"

# One stable directory of symlinks. The tmux server freezes PATH at start and
# keeps resolving against the bin dirs present then, so tmux/bin-sync aggregates
# every topic's scripts here to keep newly added topics reachable.
export PATH="$ZSH/tmux/bin:$PATH"
