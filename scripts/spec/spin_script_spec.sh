#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2329
#
# bin/spin is the command form of scripts/lib/spin.sh, for the TypeScript
# callers that cannot source it. scripts/spec/spin_spec.sh covers the branch
# itself. These cover what the wrapper adds: that the arguments arrive as
# given and the command's status comes back out.

Describe "bin/spin"
  script="$SHELLSPEC_PROJECT_ROOT/../bin/spin"

  setup() {
    root=$(mktemp -d)
    stub_gum "$root"
  }

  cleanup() {
    rm -rf "$root"
  }

  BeforeEach 'setup'
  AfterEach 'cleanup'

  run_spin() {
    PATH="$root:$PATH" "$script" "$@"
  }

  It "runs the command and passes its output through"
    When run run_spin --title "Working" -- printf 'ran\n'
    The status should be success
    The output should equal "ran"
    The stderr should be present
  End

  It "returns the command's status"
    When run run_spin --title "Pushing" -- false
    The status should be failure
    The stderr should include "Pushing"
  End

  # The failure that made the library check for it: a caller that built an
  # empty argument list would otherwise report a step that never ran as done.
  It "refuses an empty command"
    When run run_spin --title "Syncing" --
    The status should equal 2
    The stderr should include "no command to run"
  End

  # A value carrying spaces has to arrive as one argument, or a title becomes
  # a command and the spinner runs the wrong thing.
  It "keeps a quoted argument whole"
    When run run_spin --title "Fetching origin/main (attempt 1/4)" -- printf '%s\n' "one two"
    The output should equal "one two"
    The stderr should include "Fetching origin/main (attempt 1/4)"
  End
End
