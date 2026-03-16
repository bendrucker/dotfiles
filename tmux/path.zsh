#!/usr/bin/env zsh

for d in $ZSH/tmux/*/bin(N); do
  export PATH="$d:$PATH"
done
