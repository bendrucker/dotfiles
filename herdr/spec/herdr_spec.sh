#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "herdr"
  config="${XDG_CONFIG_HOME:-$HOME/.config}/herdr/config.toml"

  It "symlinks the config into place"
    When call test -L "$config"
    The status should be success
  End

  It "config is readable and non-empty"
    When call test -s "$config"
    The status should be success
  End
End
