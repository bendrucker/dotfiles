#!/usr/bin/env bash

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
