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

  It "resolves the configured statusline theme"
    check_statusline() {
      nvim --headless -c 'luafile spec/support/statusline_check.lua' 2>&1
    }
    When call check_statusline
    The status should be success
    The output should include "resolves"
  End

  It "installs a working parser for every declared treesitter language"
    check_treesitter() {
      nvim --headless -c 'luafile spec/support/treesitter_check.lua' 2>&1
    }
    When call check_treesitter
    The status should be success
    The output should include "tree-sitter CLI"
  End
End
