#!/usr/bin/env zsh

# grc (generic colorizer) for unix tools
if (( $+commands[grc] )); then
  source "$HOMEBREW_PREFIX/etc/grc.zsh"
fi
