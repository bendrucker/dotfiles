#!/usr/bin/env bash

DEFAULT_SSH_KEY="$HOME/.ssh/id_ed25519"

if [ ! -f "$DEFAULT_SSH_KEY" ]
then
  mkdir -p "$(dirname "$DEFAULT_SSH_KEY")"
  ssh-keygen -t ed25519 -f "$DEFAULT_SSH_KEY" -C "$(git config --get user.email)"
  ssh-add "$DEFAULT_SSH_KEY"
fi
