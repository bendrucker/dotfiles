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
  : >"$TODO_LOG"

  # `open` is the only way a to-do is created, so logging it is the whole
  # observation: a line means a to-do was filed, no line means the latch held.
  printf '%s\n' '#!/usr/bin/env bash' 'printf "todo\n" >>"$TODO_LOG"' \
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
