#!/usr/bin/env bash

alias keygen="ssh-keygen -t rsa -b 4096 -N '' -f"

DEFAULT_SSH_KEY="$HOME/.ssh/id_rsa"

if [ ! -f "$DEFAULT_SSH_KEY" ]
then
  mkdir -p "$(dirname "$DEFAULT_SSH_KEY")"
  keygen "$DEFAULT_SSH_KEY" -C "$(git config --get user.email)"
  ssh-add "$DEFAULT_SSH_KEY"
fi
