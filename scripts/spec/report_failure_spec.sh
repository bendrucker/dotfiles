#!/usr/bin/env bash
# shellcheck disable=SC2329
#
# The shim is the boundary five shell callers were written against, and they pass
# their arguments by position. A slot that shifts files a to-do naming the wrong
# thing, or latches the wrong job, with nothing to say it went wrong. The latch,
# the trimming and the to-do itself are covered in scripts/lib/report-failure.test.ts.

setup() {
  sandbox="$SHELLSPEC_TMPBASE/report-failure-shim"
  recorded="$sandbox/argv"
  rm -rf "$sandbox"
  mkdir -p "$sandbox/bin" "$sandbox/scripts/lib"

  # A copy rather than the real tree, so sourcing it also exercises the shim
  # finding bin/report-failure from wherever it happens to sit.
  cp "$SHELLSPEC_PROJECT_ROOT/lib/report-failure.sh" "$sandbox/scripts/lib/report-failure.sh"

  # One argument per line, so a slot that moved shows up as a line that moved.
  printf '%s\n' '#!/usr/bin/env bash' "printf '%s\\n' \"\$@\" > \"$recorded\"" \
    > "$sandbox/bin/report-failure"
  chmod +x "$sandbox/bin/report-failure"
}

BeforeEach 'setup'

argv() { cat "$recorded"; }

Describe "report_failure"
  It "hands all eight positionals to their flags"
    call_all() {
      . "$sandbox/scripts/lib/report-failure.sh"
      report_failure JOB TITLE COMMAND OUTPUT REVISION META HEADING FINGERPRINT
    }
    When call call_all
    The status should be success
    The result of function argv should equal "$(printf '%s\n' \
      failure --job=JOB --title=TITLE --command=COMMAND --output=OUTPUT \
      --revision=REVISION --extra-meta=META --output-heading=HEADING \
      --fingerprint=FINGERPRINT)"
  End

  # bin/dotfiles-upgrade and bin/worktree-prune both call it with only the
  # required five.
  It "defaults the three optional positionals"
    call_required() {
      . "$sandbox/scripts/lib/report-failure.sh"
      report_failure JOB TITLE COMMAND OUTPUT REVISION
    }
    When call call_required
    The status should be success
    The result of function argv should equal "$(printf '%s\n' \
      failure --job=JOB --title=TITLE --command=COMMAND --output=OUTPUT \
      --revision=REVISION --extra-meta= '--output-heading=Error Output' \
      --fingerprint=)"
  End

  # bin/worktree-prune passes an explanation whose first character is a newline,
  # and a reproduction command running to several hundred characters.
  It "keeps a multi-line argument in one slot"
    call_multiline() {
      . "$sandbox/scripts/lib/report-failure.sh"
      report_failure JOB TITLE "$(printf 'cd here\nrun this')" OUTPUT REVISION
    }
    When call call_multiline
    The status should be success
    The result of function argv should include "$(printf 'cd here\nrun this')"
  End
End

Describe "report_success"
  It "names the job it clears"
    call_success() {
      . "$sandbox/scripts/lib/report-failure.sh"
      report_success JOB
    }
    When call call_success
    The status should be success
    The result of function argv should equal "$(printf '%s\n' success --job=JOB)"
  End
End

Describe "notify"
  # scripts/spec/git_diff_review_spec.sh redefines notify to capture "$1: $2",
  # so the first two positionals are title and message wherever it is called.
  It "takes a title and a message"
    call_notify() {
      . "$sandbox/scripts/lib/report-failure.sh"
      notify TITLE MESSAGE
    }
    When call call_notify
    The status should be success
    The result of function argv should equal "$(printf '%s\n' notify --title=TITLE --message=MESSAGE)"
  End

  # bin/dotfiles-sync is the only caller that asks for a sound.
  It "passes a third positional as the sound"
    call_notify_sound() {
      . "$sandbox/scripts/lib/report-failure.sh"
      notify TITLE MESSAGE Glass
    }
    When call call_notify_sound
    The status should be success
    The result of function argv should equal "$(printf '%s\n' \
      notify --title=TITLE --message=MESSAGE --sound=Glass)"
  End
End

# Half the callers are zsh scripts, and the shim has to find the CLI relative to
# itself under a shell with no BASH_SOURCE.
Describe "sourced from zsh"
  It "resolves the CLI from its own location"
    When run zsh -c ". '$sandbox/scripts/lib/report-failure.sh'; report_success ZJOB"
    The status should be success
    The result of function argv should equal "$(printf '%s\n' success --job=ZJOB)"
  End
End
