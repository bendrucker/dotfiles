#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2329
#
# These examples run the real gum. Every other spec here stubs it, which is why
# gum 2 shipped this repo a regression nothing caught: its spinner renders
# through Bubble Tea v2, which writes frames to stderr whether or not a
# terminal is there to interpret them. The unattended jobs all run under
# `2>&1 | tee`, so the frames land in the log as raw control characters and
# ride into the Things to-do filed from it.

# shellcheck source=../lib/spin.sh
Include "$SHELLSPEC_PROJECT_ROOT/lib/spin.sh"

esc=$(printf '\033')

Describe "spin"
  # shellspec captures both streams through pipes, so every example here takes
  # the branch the unattended jobs take.
  Describe "with no terminal on stderr"
    It "runs the command and passes its output through"
      When call spin --title "Working" -- printf 'ran\n'
      The output should equal "ran"
      The stderr should be present
    End

    It "names the step, since there is no spinner to name it"
      When call spin --title "Fetching origin/main (attempt 1/4)" -- true
      The stderr should include "Fetching origin/main (attempt 1/4)"
    End

    It "returns the command's status"
      When run spin --title "Pushing" -- false
      The status should be failure
      The stderr should be present
    End

    It "accepts the output flags gum takes"
      When call spin --show-output --show-error --title "Syncing" -- printf 'ran\n'
      The output should equal "ran"
      The stderr should include "Syncing"
    End

    It "accepts an inline title"
      When call spin --title="Syncing" -- true
      The stderr should include "Syncing"
    End

    # gum spin rejects a call with nothing after the separator. Running the
    # empty argument list instead would report a sync that never fetched as a
    # success.
    It "refuses a call with no command"
      When run spin --title "Syncing" --
      The status should be failure
      The stderr should include "no command"
    End

    # bin/dotf runs before scripts/install has installed gum, and a missing
    # spinner is no reason to skip the work it was wrapping.
    It "runs the command when gum is not installed"
      empty="$SHELLSPEC_TMPBASE/spin/empty"
      mkdir -p "$empty"
      PATH="$empty"
      When call spin --title "Working" -- /bin/echo ran
      The output should equal "ran"
      The stderr should equal ""
    End

    It "writes no terminal control sequences"
      When call spin --title "Working" -- printf 'ran\n'
      The output should not include "$esc"
      The stderr should not include "$esc"
    End
  End

  Describe "with a terminal on stderr"
    setup() {
      stubdir="$SHELLSPEC_TMPBASE/spin/stub"
      rm -rf "$stubdir"
      mkdir -p "$stubdir"

      export GUM_LOG="$SHELLSPEC_TMPBASE/spin/gum.log"
      : >"$GUM_LOG"
      # printf, not a here-document: bash stages those through a temp file it
      # picks itself, which a sandbox may deny.
      printf '%s\n' \
        '#!/usr/bin/env bash' \
        'printf "%s\n" "$*" >>"$GUM_LOG"' \
        >"$stubdir/gum"
      chmod +x "$stubdir/gum"

      PATH="$stubdir:$PATH"
    }
    BeforeEach 'setup'

    # The one branch a spec cannot reach by redirecting streams.
    spin_has_terminal() { true; }

    gum_call() { cat "$GUM_LOG"; }

    It "hands the command to gum with its flags intact"
      When call spin --show-error --title "Pushing branch" -- git push -u origin branch
      The result of function gum_call should equal \
        "spin --show-error --title Pushing branch -- git push -u origin branch"
    End
  End
End
