#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016

Describe "herdr-flock"
  launcher="$SHELLSPEC_PROJECT_ROOT/bin/herdr-flock"
  config="$SHELLSPEC_PROJECT_ROOT/config.toml"

  It "is executable"
    When call test -x "$launcher"
    The status should be success
  End

  It "passes shellcheck"
    no_shellcheck() { ! command -v shellcheck >/dev/null 2>&1; }
    Skip if "shellcheck is not installed" no_shellcheck
    When call shellcheck "$launcher"
    The status should be success
  End

  It "is reachable on PATH from a login shell"
    # path.zsh is one of the two files .zshrc skips, so sourcing it under a
    # chosen $ZSH is what the shell does to it. -f keeps the installed root out.
    on_path() {
      local root resolved
      root=$(cd "$SHELLSPEC_PROJECT_ROOT/.." && pwd)
      resolved=$(zsh -fc 'ZSH=$1; source "$ZSH/herdr/path.zsh"; command -v herdr-flock' _ "$root") || return
      if [[ ! "$resolved" -ef "$SHELLSPEC_PROJECT_ROOT/bin/herdr-flock" ]]; then
        echo "resolved $resolved, expected $SHELLSPEC_PROJECT_ROOT/bin/herdr-flock"
        return 1
      fi
    }
    When call on_path
    The status should be success
  End

  It "binds the launcher by the name PATH exports"
    # The binding names the command bare, so it fires only while this entry and
    # the PATH export above agree.
    When call grep -q 'command = "herdr-flock"' "$config"
    The status should be success
  End

  It "refuses without herdr on PATH"
    refuse() {
      PATH=/usr/bin:/bin bash "$SHELLSPEC_PROJECT_ROOT/bin/herdr-flock" 2>&1
    }
    When call refuse
    The status should be failure
    The output should include "not on PATH"
  End
End
