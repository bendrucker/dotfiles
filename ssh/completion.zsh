#!/usr/bin/env zsh

# tssh is a drop-in ssh client, so ssh's completion covers it, including hosts
# from ~/.ssh/config. trzsz-ssh ships no completion of its own.
if (( $+commands[tssh] )); then
  compdef _ssh tssh
fi
