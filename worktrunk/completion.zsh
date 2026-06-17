#!/usr/bin/env zsh

# init.zsh (sourced before compinit) defines _wt_lazy_complete but cannot bind it,
# since compdef does not exist until compinit runs. Bind it here, after compinit.
# The lazy completer delegates to clap's dynamic completer (COMPLETE=zsh wt), which
# yields branch and worktree names. Do not eval `wt config shell completions zsh`:
# on the installed binary that emits a static completer (subcommands and flags only).
if (( $+functions[_wt_lazy_complete] )); then
  compdef _wt_lazy_complete wt
  # Single-column display keeps each branch's recency description on its own line.
  zstyle ':completion:*:wt:*' list-max 1
  zstyle ':completion:*:*:wt:*' list-grouped false
fi
