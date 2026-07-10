#!/usr/bin/env zsh

# aliases are substituted before completion
setopt no_complete_aliases

# matches case insensitive for lowercase
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Z}'

# pasting with tabs doesn't perform completion
zstyle ':completion:*' insert-tab pending

compdef _dotfiles dotfiles

# atuin config and packaging live in the atuin/ topic. The init stays here
# because it must load after `fzf --zsh` (system topic) so atuin keeps ctrl-r.
# up/down arrows stay on history-substring-search
if (( $+commands[atuin] )); then
  eval "$(atuin init zsh --disable-up-arrow)"
fi
