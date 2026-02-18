#!/usr/bin/env zsh

# aliases are substituted before completion
setopt no_complete_aliases

# matches case insensitive for lowercase
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Z}'

# pasting with tabs doesn't perform completion
zstyle ':completion:*' insert-tab pending

compdef _dotfiles dotfiles
