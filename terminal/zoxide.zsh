#!/usr/bin/env zsh

if (( $+commands[zoxide] )); then
  eval "$(zoxide init zsh)"

  # Jump, then start Claude there. `z` is a shell function, so calling it here
  # moves the calling shell and Claude inherits the new directory. Passes no
  # --permission-mode: the mode comes from Claude's own default.
  if (( $+commands[claude] )); then
    zc() {
      z "$@" && claude
    }
  fi
fi
