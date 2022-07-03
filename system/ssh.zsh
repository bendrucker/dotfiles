#!/usr/bin/env bash

alias keygen="ssh-keygen -t rsa -b 4096 -N '' -f"

DEFAULT_SSH_KEY="$HOME/.ssh/id_rsa"

if [ ! -f "$DEFAULT_SSH_KEY" ]
then
  mkdir -p "$(dirname "$DEFAULT_SSH_KEY")"
  keygen "$DEFAULT_SSH_KEY" -C "$(git config --get user.email)"
  ssh-add "$DEFAULT_SSH_KEY"
fi

firewall_allow_mosh_server() {
  local fw mosh_sym mosh_abs
  fw='/usr/libexec/ApplicationFirewall/socketfilterfw'
  mosh_sym="$(which mosh-server)"
  mosh_abs="$(greadlink -f "$mosh_sym")"

  sudo "$fw" --setglobalstate off
  sudo "$fw" --add "$mosh_sym"
  sudo "$fw" --unblockapp "$mosh_sym"
  sudo "$fw" --add "$mosh_abs"
  sudo "$fw" --unblockapp "$mosh_abs"
  sudo "$fw" --setglobalstate on
}
