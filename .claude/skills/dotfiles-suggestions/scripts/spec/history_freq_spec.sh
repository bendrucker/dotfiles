#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "history-freq.sh"
  Before 'setup_fixture'
  After 'cleanup_fixture'

  It "shows git as the most frequent command"
    When run command env HISTFILE="$HISTFILE" "$SHELLSPEC_SPECDIR/../history-freq.sh"
    The line 1 of output should include "git"
  End

  It "outputs a valid date range"
    When run command env HISTFILE="$HISTFILE" "$SHELLSPEC_SPECDIR/../history-freq.sh" --date-range
    The output should match pattern "????-??-?? to ????-??-??"
  End

  It "limits output with -n"
    When run command env HISTFILE="$HISTFILE" "$SHELLSPEC_SPECDIR/../history-freq.sh" -n 3
    The lines of output should equal 3
  End

  It "excludes continuation lines"
    When run command env HISTFILE="$HISTFILE" "$SHELLSPEC_SPECDIR/../history-freq.sh"
    The output should not include "continuation"
  End

  It "fails when --recent has no argument"
    When run command env HISTFILE="$HISTFILE" "$SHELLSPEC_SPECDIR/../history-freq.sh" --recent
    The status should be failure
    The stderr should include "requires an argument"
  End
End
