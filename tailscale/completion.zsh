#!/usr/bin/env zsh

if (( $+commands[tailscale] )); then
  eval "$(tailscale completion zsh)"
fi
