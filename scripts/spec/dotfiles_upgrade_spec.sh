#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "dotfiles-upgrade failure reporting"
  dotfiles_upgrade="$SHELLSPEC_PROJECT_ROOT/../bin/dotfiles-upgrade"

  setup() {
    sandbox="$SHELLSPEC_TMPBASE/dotfiles-upgrade"
    home="$sandbox/dotfiles"
    stubdir="$sandbox/stub"
    opened="$sandbox/opened"
    rm -rf "$sandbox"
    mkdir -p "$stubdir" "$home/bin" "$sandbox/state"

    stub_gum "$stubdir"

    # report_failure files the to-do by handing a things:/// URL to `open`.
    # Record it instead of launching Things.
    printf '%s\n' \
      '#!/usr/bin/env bash' \
      "printf '%s\\n' \"\$1\" >> \"$opened\"" \
      > "$stubdir/open"
    chmod +x "$stubdir/open"

    stub_osascript "$stubdir"

    printf '#!/usr/bin/env bash\necho "fatal: could not read from remote" >&2\nexit 1\n' \
      > "$home/bin/dotfiles-sync"
    chmod +x "$home/bin/dotfiles-sync"
  }

  # `zsh -f` so the script's startup skips ~/.zshenv, which exports
  # DOTFILES_HOME unconditionally and would clobber the sandbox path.
  run_upgrade() {
    PATH="$stubdir:$PATH" DOTFILES_HOME="$home" XDG_STATE_HOME="$sandbox/state" \
      zsh -f "$dotfiles_upgrade"
  }

  BeforeEach 'setup'

  todo_filed() { grep -c "things:///add" "$opened" 2>/dev/null || echo 0; }

  # Regression: a failing sync used to log and exit 1 with no report_failure
  # call, so an unattended failure surfaced only as a notification banner that
  # fires at 3am and is gone before anyone looks.
  It "files a to-do when the sync fails"
    When call run_upgrade
    The status should equal 1
    The stderr should include "sync failed"
    The result of function todo_filed should equal 1
  End

  # The to-do carries the sync's own output, which is the part worth reading
  # the next morning.
  It "names the sync and carries its output"
    When call run_upgrade
    The status should equal 1
    The contents of file "$opened" should include "Dotfiles%20sync%20failed"
    The contents of file "$opened" should include "could%20not%20read%20from%20remote"
    The stdout should include "could not read from remote"
    The stderr should be present
  End

  # The latch in report_failure keeps a job that stays broken from filing a
  # fresh to-do every night.
  It "stays quiet while the sync keeps failing"
    run_upgrade >/dev/null 2>&1 || true
    When call run_upgrade
    The status should equal 1
    The result of function todo_filed should equal 1
    The stderr should include "to-do already filed"
  End
End

Describe "dotfiles-upgrade drift reporting"
  dotfiles_upgrade="$SHELLSPEC_PROJECT_ROOT/../bin/dotfiles-upgrade"

  setup() {
    sandbox="$SHELLSPEC_TMPBASE/dotfiles-upgrade-drift"
    home="$sandbox/dotfiles"
    stubdir="$sandbox/stub"
    opened="$sandbox/opened"
    drift="$sandbox/drift"
    rm -rf "$sandbox"
    mkdir -p "$stubdir" "$home/bin" "$home/scripts" "$sandbox/state"

    stub_gum "$stubdir"

    printf '%s\n' \
      '#!/usr/bin/env bash' \
      "printf '%s\\n' \"\$1\" >> \"$opened\"" \
      > "$stubdir/open"
    chmod +x "$stubdir/open"

    stub_osascript "$stubdir"

    printf '#!/usr/bin/env bash\nexit 0\n' > "$stubdir/brew"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$home/bin/dotfiles-sync"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$home/scripts/install"
    chmod +x "$stubdir/brew" "$home/bin/dotfiles-sync" "$home/scripts/install"

    : > "$drift"
    printf '%s\n' '#!/usr/bin/env bash' "cat '$drift'" > "$home/scripts/brew-drift"
    chmod +x "$home/scripts/brew-drift"
  }

  run_upgrade() {
    PATH="$stubdir:$PATH" DOTFILES_HOME="$home" XDG_STATE_HOME="$sandbox/state" \
      zsh -f "$dotfiles_upgrade"
  }

  BeforeEach 'setup'

  todo_filed() { grep -c "things:///add" "$opened" 2>/dev/null || echo 0; }

  It "files a to-do listing what no Brewfile declares"
    printf "brew 'cmake'\n" > "$drift"

    When call run_upgrade
    The status should equal 0
    The result of function todo_filed should equal 1
    The contents of file "$opened" should include "Undeclared%20Homebrew%20packages"
    The contents of file "$opened" should include "cmake"
    The stderr should include "undeclared packages installed"
    The stdout should be present
  End

  # This test only holds because the drift check never auto-resolves a
  # standing to-do.
  It "stays quiet while the same packages stay undeclared"
    printf "brew 'cmake'\n" > "$drift"
    run_upgrade >/dev/null 2>&1 || true

    When call run_upgrade
    The status should equal 0
    The result of function todo_filed should equal 1
    The stderr should include "to-do already filed"
    The stdout should be present
  End

  # A package installed while an older finding is still standing is reported
  # as a new finding, because each finding is tracked by its own fingerprint.
  It "files a fresh to-do when a new package appears"
    printf "brew 'cmake'\n" > "$drift"
    run_upgrade >/dev/null 2>&1 || true
    printf "brew 'cmake'\ncask 'figma'\n" > "$drift"

    When call run_upgrade
    The status should equal 0
    The result of function todo_filed should equal 2
    The contents of file "$opened" should include "figma"
    The stdout should be present
    The stderr should be present
  End

  # Homebrew orders the listing by a dependency sort taken over every installed
  # package, so installing something unrelated and declared can reshuffle the
  # undeclared names. The latch keys on the sorted set, which is what keeps that
  # from filing a duplicate to-do for a finding already standing.
  It "stays quiet when the same packages come back in another order"
    printf "brew 'cmake'\ncask 'figma'\n" > "$drift"
    run_upgrade >/dev/null 2>&1 || true
    printf "cask 'figma'\nbrew 'cmake'\n" > "$drift"

    When call run_upgrade
    The status should equal 0
    The result of function todo_filed should equal 1
    The stderr should include "to-do already filed"
    The stdout should be present
  End

  It "files nothing when the machine matches the Brewfile"
    When call run_upgrade
    The status should equal 0
    The result of function todo_filed should equal 0
    The stdout should be present
    The stderr should be present
  End

  # The install has already succeeded by this point, so a drift check that
  # cannot run is worth a line in the log and nothing more.
  It "completes the run when the drift check cannot run"
    rm -f "$home/scripts/brew-drift"

    When call run_upgrade
    The status should equal 0
    The result of function todo_filed should equal 0
    The stderr should include "brew drift check could not run"
    The stdout should be present
  End
End
