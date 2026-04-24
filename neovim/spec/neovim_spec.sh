#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "neovim"
  It "starts without errors"
    start_nvim() {
      local output
      output=$(nvim --headless +qa 2>&1) || return $?
      if echo "$output" | grep -qE 'E[0-9]+:|stack traceback'; then
        echo "$output"
        return 1
      fi
    }
    When call start_nvim
    The status should be success
  End
End
