#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "git"
  It "loads the global config"
    When call git config --global --get alias.co
    The status should be success
    The output should equal "checkout"
  End

  It "resolves the ignore file referenced by core.excludesfile"
    excludes=$(git config --global --get core.excludesfile)
    expanded="${excludes/#\~/$HOME}"
    When call test -r "$expanded"
    The status should be success
  End

  It "applies core.excludesfile to new repos"
    check_ignore() {
      local repo="$SHELLSPEC_TMPBASE/ignore-test"
      git init -q "$repo"
      git -C "$repo" check-ignore -q .DS_Store
    }
    When call check_ignore
    The status should be success
  End
End
