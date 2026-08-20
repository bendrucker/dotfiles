#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016
#
# Locks the guard around the Vibe Island preference write: it touches nothing on
# a machine without the app, it writes at most once so the nightly install does
# not rewrite a preference already set, and when the app is running it quits
# before writing and reopens after. Writing under a running app is what let the
# app put its own value back while this preference still read 0.
#
# Black-box, following claude/spec/claude_prune_agents_spec.sh: PATH-shim stubs
# for defaults, pgrep, osascript, open, sleep, and gum drive the real script,
# and VIBE_ISLAND_APP points at a fixture bundle so no real preference domain is
# read or written. Every stub appends to one log, so an example can assert on
# the order the script did things in.

script="$SHELLSPEC_PROJECT_ROOT/vibe-island.sh"

setup() {
  sandbox="$SHELLSPEC_TMPBASE/vibe-island"
  stubdir="$sandbox/stub"
  rm -rf "$sandbox"
  mkdir -p "$stubdir"

  export ACTION_LOG="$sandbox/actions.log"
  : >"$ACTION_LOG"

  # An installed app, by default. $CURRENT_VALUE is what `defaults read` answers
  # with until something writes, empty standing for a key that was never
  # written, which the real defaults reports as a failure rather than as empty
  # output. A write lands in $PREF_FILE, so a later read sees it.
  export VIBE_ISLAND_APP="$sandbox/Vibe Island.app"
  mkdir -p "$VIBE_ISLAND_APP"
  export CURRENT_VALUE=""
  export PREF_FILE="$sandbox/pref"

  # The app is either not running, or running and willing to quit. $QUIT_REFUSED
  # makes it ignore the quit, and $QUIT_FLAG is how the osascript stub tells the
  # pgrep stub the process is gone.
  export APP_RUNNING=""
  export QUIT_REFUSED=""
  export QUIT_FLAG="$sandbox/quit"

  # The app that ignores the opt-out: relaunching puts hook management back on.
  export APP_CLOBBERS=""

  # printf, not a here-document: bash stages those through a temp file it picks
  # itself, which a sandbox may deny. Same reasoning as scripts/spec/spec_helper.sh.
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\n" "defaults $*" >>"$ACTION_LOG"' \
    'case "$1" in' \
    '  read)' \
    '    value="$CURRENT_VALUE"' \
    '    [ -f "$PREF_FILE" ] && value=$(cat "$PREF_FILE")' \
    '    [ -n "$value" ] || exit 1' \
    '    printf "%s\n" "$value"' \
    '    ;;' \
    '  write)' \
    '    case "${*: -1}" in' \
    '      false) printf 0 >"$PREF_FILE" ;;' \
    '      *)     printf 1 >"$PREF_FILE" ;;' \
    '    esac' \
    '    ;;' \
    'esac' \
    'exit 0' \
    >"$stubdir/defaults"
  chmod +x "$stubdir/defaults"

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    '[ -f "$QUIT_FLAG" ] && exit 1' \
    '[ -n "$APP_RUNNING" ]' \
    >"$stubdir/pgrep"
  chmod +x "$stubdir/pgrep"

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\n" "osascript $*" >>"$ACTION_LOG"' \
    '[ -n "$QUIT_REFUSED" ] || : >"$QUIT_FLAG"' \
    'exit 0' \
    >"$stubdir/osascript"
  chmod +x "$stubdir/osascript"

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\n" "open $*" >>"$ACTION_LOG"' \
    'rm -f "$QUIT_FLAG"' \
    '[ -n "$APP_CLOBBERS" ] && printf 1 >"$PREF_FILE"' \
    'exit 0' \
    >"$stubdir/open"
  chmod +x "$stubdir/open"

  # The waits are bounded in real seconds. An example should not spend them.
  printf '#!/usr/bin/env bash\nexit 0\n' >"$stubdir/sleep"
  chmod +x "$stubdir/sleep"

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
    The contents of file "$ACTION_LOG" should include \
      "defaults write app.vibeisland.macos hookAutoConfig_claude -bool false"
  End

  # The app owns this key too. A value of 1 means it has taken hook management
  # back, so the install has to correct it.
  It "turns it off again after the app turns it back on"
    export CURRENT_VALUE=1
    When call run_script
    The status should be success
    The contents of file "$ACTION_LOG" should include "-bool false"
  End

  # The install runs nightly. Rewriting a preference already set would quit the
  # app out from under the user every night for a change that has already taken.
  It "leaves a preference already set alone"
    export CURRENT_VALUE=0
    When call run_script
    The status should be success
    The contents of file "$ACTION_LOG" should not include "write"
    The contents of file "$ACTION_LOG" should not include "osascript"
  End

  It "does nothing on a machine without the app"
    rm -rf "$VIBE_ISLAND_APP"
    When call run_script
    The status should be success
    The contents of file "$ACTION_LOG" should equal ""
  End

  It "says nothing when the app is not installed but is somehow running"
    rm -rf "$VIBE_ISLAND_APP"
    export APP_RUNNING=1
    When call run_script
    The status should be success
    The stderr should equal ""
  End

  Describe "with the app running"
    BeforeEach 'export APP_RUNNING=1'

    # NSUserDefaults holds what the app read at launch, and the app can write
    # that copy back, so a write under a running app is the one that gets lost.
    It "quits the app before writing"
      When call run_script
      The status should be success
      The contents of file "$ACTION_LOG" should match pattern "*osascript*quit app*defaults write*"
    End

    # Quitting takes the menu bar with it, so the script owns putting it back.
    It "reopens the app after writing"
      When call run_script
      The status should be success
      The contents of file "$ACTION_LOG" should match pattern "*defaults write*open -a*"
    End

    It "stays quiet when the quit and the write both take"
      When call run_script
      The status should be success
      The stderr should equal ""
    End

    # An app that ignores the opt-out is not one a relaunch can fix. Only
    # claude-upgrade's revert defends the config from there, so say so.
    It "warns when hook management is back on after the relaunch"
      export APP_CLOBBERS=1
      When call run_script
      The status should be success
      The stderr should include "ignoring the opt-out"
    End

    # An app that will not quit leaves the old behavior: write anyway, and say
    # the value may not survive. Killing it or leaving it dead would cost the
    # user their menu bar for a preference write.
    It "writes and warns when the app will not quit"
      export QUIT_REFUSED=1
      When call run_script
      The status should be success
      The stderr should include "would not quit"
      The contents of file "$ACTION_LOG" should include "-bool false"
      The contents of file "$ACTION_LOG" should not include "open -a"
    End
  End

  Describe "with the app not running"
    It "neither quits nor reopens"
      When call run_script
      The status should be success
      The contents of file "$ACTION_LOG" should not include "osascript"
      The contents of file "$ACTION_LOG" should not include "open -a"
    End

    It "stays quiet"
      When call run_script
      The status should be success
      The stderr should equal ""
    End
  End
End
