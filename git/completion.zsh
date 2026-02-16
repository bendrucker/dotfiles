#!/usr/bin/env zsh

if (( $+commands[gt] )); then
  eval "$(gt completion)"
fi
