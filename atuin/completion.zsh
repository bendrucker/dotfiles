#!/usr/bin/env zsh

# atuin init (in zsh/completion.zsh) sets up widgets and keybindings but not
# completion for the atuin CLI itself. No fzf load-order dependency here.
_eval_cache atuin gen-completions --shell zsh && eval "$REPLY"
