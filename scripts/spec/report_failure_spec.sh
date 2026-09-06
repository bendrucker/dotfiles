#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016
#
# Locks the latch that decides whether an unattended job's failure reaches
# Things. The latch is the whole point of the file: a job that files a to-do
# every night trains you to ignore it, and one that files none after the first
# leaves later breakage silent. The fingerprint cases cover a job whose output
# is a set of findings, where the second of those failures is the live risk.

# shellcheck source=../lib/report-failure.sh
Include "$SHELLSPEC_PROJECT_ROOT/lib/report-failure.sh"

setup() {
  sandbox="$SHELLSPEC_TMPBASE/report-failure"
  stubdir="$sandbox/stub"
  rm -rf "$sandbox"
  mkdir -p "$stubdir"
  stub_gum "$stubdir"
  stub_osascript "$stubdir"

  export XDG_STATE_HOME="$sandbox/state"
  export TODO_LOG="$sandbox/todos.log"
  export TODO_NOTES="$sandbox/notes.txt"
  : >"$TODO_LOG"
  : >"$TODO_NOTES"

  # `open` is the only way a to-do is created, so logging it is the whole
  # observation: a line means a to-do was filed, no line means the latch held.
  #
  # The trimming cases read the note back out of the URL. jq's @uri leaves no
  # literal & or % behind, so the field splits on & and decodes by turning each
  # escape into printf's. sed does that rewrite because bash 3.2's global
  # substitution is quadratic, and took minutes on a note of this size.
  printf '%s\n' '#!/usr/bin/env bash' \
    'printf "todo\n" >>"$TODO_LOG"' \
    'notes="${1#*&notes=}"; notes="${notes%%&*}"' \
    'printf "%b" "$(printf "%s" "$notes" | sed "s/%/\\\\x/g")" >"$TODO_NOTES"' \
    >"$stubdir/open"
  chmod +x "$stubdir/open"
}

BeforeEach 'setup'

fail() {
  PATH="$stubdir:$PATH" report_failure drift "Stale" "audit" "$1" "abc123" "" "Findings" "$2"
}
todos() { wc -l <"$TODO_LOG" | tr -d ' '; }

Describe "report_failure latch"
  It "files a to-do on the first failure"
    When call fail "one plugin stale" ""
    The status should be success
    The stderr should be defined
    The result of function todos should equal 1
  End

  It "stays quiet while the job keeps failing the same way"
    fail "one plugin stale" "" >/dev/null 2>&1
    When call fail "one plugin stale" ""
    The status should be success
    The stderr should be defined
    The result of function todos should equal 1
  End

  It "files again after report_success clears the latch"
    fail "one plugin stale" "" >/dev/null 2>&1
    report_success drift
    When call fail "one plugin stale" ""
    The status should be success
    The stderr should be defined
    The result of function todos should equal 2
  End
End

Describe "report_failure fingerprint"
  # Without this, the first plugin to go stale suppresses every plugin that goes
  # stale afterwards, for as long as the first one stays broken.
  It "files again when the findings change"
    fail "alpha stale" "alpha" >/dev/null 2>&1
    When call fail "alpha stale, beta stale" "alpha-beta"
    The status should be success
    The stderr should be defined
    The result of function todos should equal 2
  End

  It "stays quiet when the findings are unchanged"
    fail "alpha stale" "alpha" >/dev/null 2>&1
    When call fail "alpha stale" "alpha"
    The status should be success
    The stderr should be defined
    The result of function todos should equal 1
  End
End

# Things stores 10,000 characters of notes and drops the rest. claude-upgrade
# opens its log with a repository sync whose diffstat alone ran past that, and
# filed to-dos holding the diffstat and none of the error that ended the run.
Describe "report_failure output trimming"
  It "leaves an output that already fits alone"
    When call trim_output "short log" 100
    The output should equal "short log"
  End

  long_log() { seq --format 'drop-%02g' 1 20; printf 'keep me'; }

  It "keeps the end of an output that does not fit"
    When call trim_output "$(long_log)" 60
    The output should include "keep me"
    The output should not include "drop-01"
  End

  It "says how much it dropped"
    When call trim_output "$(long_log)" 60
    The output should include "characters elided"
  End

  # A cut taken at the budget alone lands mid-line, and the note then opens on
  # the tail end of a word.
  It "resumes at a line boundary rather than mid-word"
    When call trim_output "$(seq --format 'line-%02g-padding' 1 20)" 100
    The line 1 of output should include "characters elided"
    The line 2 of output should start with "line-"
  End

  # The motivating log ends in one long unwrapped error line, which leaves no
  # newline inside the budget to resume at.
  It "resumes at a word boundary inside a line longer than the budget"
    When call trim_output "short$(printf ' word-%03d' $(seq 40))" 60
    The line 2 of output should start with "word-"
  End

  # The marker is what says the log was cut, and it spends budget of its own. A
  # budget too small for it overran the note it was measured to fit inside.
  It "yields nothing when the budget cannot hold the marker"
    When call trim_output "$(long_log)" 10
    The output should equal ""
  End

  big_log() {
    for _ in $(seq 400); do printf ' plugins/some/path.ts | 12 ++++\n'; done
    printf 'WARN the actual failure\n'
  }
  note_within_limit() { [ "$(wc -c <"$TODO_NOTES")" -le 10000 ]; }

  It "keeps the note within what Things stores"
    fail "$(big_log)" "" >/dev/null 2>&1
    When call note_within_limit
    The status should be success
  End

  # The regression: the error is the last line, and it was the part Things cut.
  It "keeps the error that ended the run"
    When call fail "$(big_log)" ""
    The status should be success
    The stderr should be defined
    The contents of file "$TODO_NOTES" should include "WARN the actual failure"
  End
End
