#!/usr/bin/env zsh

if command -v herdr > /dev/null; then
  eval "$(herdr completion zsh)"
fi
