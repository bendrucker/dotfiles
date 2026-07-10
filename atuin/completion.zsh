#!/usr/bin/env zsh

# atuin init (in zsh/completion.zsh) sets up widgets and keybindings but not
# completion for the atuin CLI itself. No fzf load-order dependency here.
if (( $+commands[atuin] )); then
  eval "$(atuin gen-completions --shell zsh)"
fi
