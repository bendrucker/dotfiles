#!/usr/bin/env zsh

# Loaded after colors/grc.zsh, whose `ls` alias these replace.
if (( $+commands[eza] )); then
  alias ls='eza --group-directories-first --icons=auto --classify=auto'
  alias l='ls --long --all --header --git'
  alias ll='ls --long --header --git'
  alias la='ls --all'
  alias lt='ls --tree --level=2'
  alias tree='eza --tree'
fi
