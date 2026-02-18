#!/usr/bin/env zsh

local inc="$HOMEBREW_PREFIX/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/completion.zsh.inc"
[[ -f "$inc" ]] && source "$inc"
