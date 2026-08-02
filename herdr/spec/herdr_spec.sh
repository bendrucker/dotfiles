#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016

Describe "herdr"
  config="${XDG_CONFIG_HOME:-$HOME/.config}/herdr/config.toml"
  list="$SHELLSPEC_PROJECT_ROOT/plugins.list"

  It "symlinks the config into place"
    When call test -L "$config"
    The status should be success
  End

  It "config is readable and non-empty"
    When call test -s "$config"
    The status should be success
  End

  It "declares the plugin set in plugins.list"
    When call test -s "$list"
    The status should be success
  End

  It "points HERDR_LAZY_LIST at plugins.list"
    # .zshrc sources every $ZSH/**/*.zsh bar path.zsh and completion.zsh, so
    # sourcing herdr.zsh under a chosen $ZSH is what a login shell does to it.
    # `zsh -f` keeps ~/.zshenv, and the installed root it exports, out of the
    # way. -ef rather than a string compare, so this also proves the export
    # names a file that exists.
    lazy_list_target() {
      local root resolved
      root=$(cd "$SHELLSPEC_PROJECT_ROOT/.." && pwd)
      resolved=$(zsh -fc 'ZSH=$1; source "$ZSH/herdr/herdr.zsh"; print -r -- $HERDR_LAZY_LIST' _ "$root") || return
      if [[ ! "$resolved" -ef "$list" ]]; then
        echo "HERDR_LAZY_LIST=$resolved, expected $list"
        return 1
      fi
    }
    When call lazy_list_target
    The status should be success
  End
End
