#!/usr/bin/env zsh

# In path.zsh (sourced by zshenv) so non-interactive shells get it too.
export TMUX_TMPDIR="$HOME/.tmux"
[[ -d "$TMUX_TMPDIR" ]] || mkdir -p "$TMUX_TMPDIR"

for d in $ZSH/tmux/*/bin(N); do
  export PATH="$d:$PATH"
done
