#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016
#
# Locks the guard around the Vibe Island preference write: it touches nothing on
# a machine without the app, and it writes at most once, so the nightly install
# neither rewrites a preference already set nor repeats the running-app warning.
#
# Black-box, following claude/spec/claude_prune_agents_spec.sh: PATH-shim stubs
# for defaults, pgrep, and gum drive the real script, and VIBE_ISLAND_APP points
# at a fixture bundle so no real preference domain is read or written.

script="$SHELLSPEC_PROJECT_ROOT/vibe-island.sh"

setup() {
  sandbox="$SHELLSPEC_TMPBASE/vibe-island"
  stubdir="$sandbox/stub"
  rm -rf "$sandbox"
  mkdir -p "$stubdir"

  export DEFAULTS_LOG="$sandbox/defaults.log"
  : >"$DEFAULTS_LOG"

  # An installed app, by default. $CURRENT_VALUE is what `defaults read` answers
  # with, empty standing for a key that was never written, which the real
  # defaults reports as a failure rather than as empty output.
  export VIBE_ISLAND_APP="$sandbox/Vibe Island.app"
  mkdir -p "$VIBE_ISLAND_APP"
  export CURRENT_VALUE=""
  export APP_RUNNING=""

  # printf, not a here-document: bash stages those through a temp file it picks
  # itself, which a sandbox may deny. Same reasoning as scripts/spec/spec_helper.sh.
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\n" "$*" >>"$DEFAULTS_LOG"' \
    'if [ "$1" = read ]; then' \
    '  [ -n "$CURRENT_VALUE" ] || exit 1' \
    '  printf "%s\n" "$CURRENT_VALUE"' \
    'fi' \
    'exit 0' \
    >"$stubdir/defaults"
  chmod +x "$stubdir/defaults"

  printf '#!/usr/bin/env bash\n[ -n "$APP_RUNNING" ]\n' >"$stubdir/pgrep"
  chmod +x "$stubdir/pgrep"

  # The real gum logs to stderr, so the warning stays off captured stdout.
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "${@: -1}" >&2\n' >"$stubdir/gum"
  chmod +x "$stubdir/gum"
}
BeforeEach 'setup'

run_script() { PATH="$stubdir:$PATH" bash "$script"; }

Describe "macos/vibe-island.sh"
  It "turns Vibe Island's Claude hook management off"
    When call run_script
    The status should be success
    The contents of file "$DEFAULTS_LOG" should include \
      "write app.vibeisland.macos hookAutoConfig_claude -bool false"
  End

  # The app owns this key too. A value of 1 means it has taken hook management
  # back, so the install has to correct it.
  It "turns it off again after the app turns it back on"
    export CURRENT_VALUE=1
    When call run_script
    The status should be success
    The contents of file "$DEFAULTS_LOG" should include "-bool false"
  End

  # The install runs nightly. Rewriting a preference already set would warn
  # about a running app every night for a change that has already taken.
  It "leaves a preference already set alone"
    export CURRENT_VALUE=0
    When call run_script
    The status should be success
    The contents of file "$DEFAULTS_LOG" should not include "write"
  End

  It "does nothing on a machine without the app"
    rm -rf "$VIBE_ISLAND_APP"
    When call run_script
    The status should be success
    The contents of file "$DEFAULTS_LOG" should equal ""
  End

  It "says nothing when the app is not installed but is somehow running"
    rm -rf "$VIBE_ISLAND_APP"
    export APP_RUNNING=1
    When call run_script
    The status should be success
    The stderr should equal ""
  End

  Describe "the running-app caveat"
    # NSUserDefaults holds what the app read at launch, and the app can write
    # that copy back, so the write alone is not enough to report as done.
    It "warns to restart the app when it is running"
      export APP_RUNNING=1
      When call run_script
      The status should be success
      The stderr should include "Quit and reopen"
    End

    It "stays quiet when the app is not running"
      When call run_script
      The status should be success
      The stderr should equal ""
    End
  End
End
