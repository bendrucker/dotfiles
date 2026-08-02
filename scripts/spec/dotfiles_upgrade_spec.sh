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

    # printf, not a here-document: bash stages those through a temp file it
    # picks itself, which a sandbox may deny.
    # shellcheck disable=SC2016 # the stub's own $1 and $@, not this shell's
    printf '%s\n' \
      '#!/usr/bin/env bash' \
      'case "$1" in' \
      '  spin)' \
      '    shift' \
      '    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done' \
      '    [ "$1" = "--" ] && shift' \
      '    exec "$@"' \
      '    ;;' \
      '  log)' \
      '    printf "%s\n" "${@: -1}" >&2' \
      '    ;;' \
      'esac' \
      > "$stubdir/gum"
    chmod +x "$stubdir/gum"

    # report_failure files the to-do by handing a things:/// URL to `open`.
    # Record it instead of launching Things.
    printf '%s\n' \
      '#!/usr/bin/env bash' \
      "printf '%s\\n' \"\$1\" >> \"$opened\"" \
      > "$stubdir/open"
    chmod +x "$stubdir/open"

    printf '#!/usr/bin/env bash\nexit 0\n' > "$stubdir/osascript"
    chmod +x "$stubdir/osascript"

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
