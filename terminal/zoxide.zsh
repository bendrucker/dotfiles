#!/usr/bin/env zsh

if (( $+commands[zoxide] )); then
  eval "$(zoxide init zsh --cmd cd)"
fi
