#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "common.sh"
  Include "$SHELLSPEC_SPECDIR/../common.sh"

  Describe "duration_to_cutoff"
    It "returns an epoch in the past for months"
      When call duration_to_cutoff "6m"
      The output should be present
      The status should be success
    End

    It "returns an epoch in the past for days"
      When call duration_to_cutoff "30d"
      The output should be present
      The status should be success
    End

    It "rejects invalid format"
      When call duration_to_cutoff "abc"
      The status should be failure
      The stderr should include "Invalid duration"
    End
  End

  Describe "format_epoch"
    It "formats a known epoch as YYYY-MM-DD"
      When call format_epoch 1700000000
      The output should match pattern "????-??-??"
      The status should be success
    End
  End

  Describe "extract_commands"
    Before 'setup_fixture'
    After 'cleanup_fixture'

    It "fails for missing file"
      When call extract_commands "/nonexistent/path"
      The status should be failure
      The stderr should include "not found"
    End

    It "extracts commands from history"
      When call extract_commands "$HISTFILE"
      The output should include "git status"
    End

    It "excludes continuation lines"
      When call extract_commands "$HISTFILE"
      The output should not include "continuation"
    End
  End

  Describe "require_arg"
    It "exits non-zero when argc < 2"
      When run command bash -c "source '$SHELLSPEC_SPECDIR/../common.sh'; require_arg --foo 1"
      The status should be failure
      The stderr should include "requires an argument"
    End
  End
End
