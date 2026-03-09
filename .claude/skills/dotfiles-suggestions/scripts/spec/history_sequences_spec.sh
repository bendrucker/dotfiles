#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "history-sequences.sh"
  Before 'setup_fixture'
  After 'cleanup_fixture'

  It "finds && chains"
    When run command env HISTFILE="$HISTFILE" "$SHELLSPEC_SPECDIR/../history-sequences.sh"
    The output should include "&&"
  End

  It "finds | pipes"
    When run command env HISTFILE="$HISTFILE" "$SHELLSPEC_SPECDIR/../history-sequences.sh"
    The output should include "|"
  End

  It "exits 0 with no sequences"
    no_sequences="$FIXTURE_DIR/no_sequences"
    printf ': 1700000000:0;echo hello\n: 1700000100:0;echo world\n' > "$no_sequences"
    When run command env HISTFILE="$no_sequences" "$SHELLSPEC_SPECDIR/../history-sequences.sh"
    The status should be success
    The output should equal ""
  End

  It "limits output with -n"
    When run command env HISTFILE="$HISTFILE" "$SHELLSPEC_SPECDIR/../history-sequences.sh" -n 1
    The lines of output should equal 1
  End
End
