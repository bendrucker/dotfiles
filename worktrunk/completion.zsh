#!/usr/bin/env zsh

if command -v wt > /dev/null; then
  eval "$(wt config shell completions zsh)"
fi
