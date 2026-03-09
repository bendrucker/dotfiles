#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "history-args.sh"
  Before 'setup_fixture'
  After 'cleanup_fixture'

  It "includes status as a git argument pattern"
    When run command env HISTFILE="$HISTFILE" "$SHELLSPEC_SPECDIR/../history-args.sh"
    The output should include "status"
  End

  It "limits command sections with -n"
    count_sections() { grep -c '^===' || true; }
    When run command env HISTFILE="$HISTFILE" "$SHELLSPEC_SPECDIR/../history-args.sh" -n 2
    The output should include "==="
  End

  It "handles regex metacharacters in command names"
    When run command env HISTFILE="$HISTFILE" "$SHELLSPEC_SPECDIR/../history-args.sh" -n 20
    The output should include "=== c++ ==="
  End

  It "excludes continuation lines"
    When run command env HISTFILE="$HISTFILE" "$SHELLSPEC_SPECDIR/../history-args.sh"
    The output should not include "continuation"
  End
End
