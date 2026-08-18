#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "dotfiles-reload"
  dotfiles_reload="$SHELLSPEC_PROJECT_ROOT/../bin/dotfiles-reload"

  setup() {
    sandbox="$SHELLSPEC_TMPBASE/dotfiles-reload"
    stubdir="$sandbox/stub"
    rm -rf "$sandbox"
    mkdir -p "$stubdir" "$sandbox/bin"

    stub_gum "$stubdir"

    # The dispatcher globs topics relative to its own parent, so it has to run
    # from a copy inside the fixture rather than from the repo.
    cp "$dotfiles_reload" "$sandbox/bin/dotfiles-reload"
  }

  # topic <name> <exit status>
  topic() {
    mkdir -p "$sandbox/$1"
    printf '#!/usr/bin/env bash\necho "%s reloaded"\nexit %s\n' "$1" "$2" \
      > "$sandbox/$1/reload.sh"
    chmod +x "$sandbox/$1/reload.sh"
  }

  run_reload() {
    PATH="$stubdir:$PATH" "$sandbox/bin/dotfiles-reload"
  }

  BeforeEach 'setup'

  It "runs every topic's reload.sh"
    topic alpha 0
    topic beta 0
    When call run_reload
    The status should be success
    The output should include "alpha reloaded"
    The output should include "beta reloaded"
  End

  It "exits 0 when no topic declares a reload"
    When call run_reload
    The status should be success
  End

  # One tool refusing to reload must not stop the rest, the same way a failing
  # topic installer doesn't abort the install.
  It "keeps going past a failing topic and reports its status"
    topic alpha 3
    topic beta 0
    When call run_reload
    The status should equal 3
    The output should include "beta reloaded"
    The stderr should include "alpha/reload.sh exited 3"
  End

  # A reload.sh that lost its exec bit would otherwise be run through the
  # shell's interpreter guess, or fail as "permission denied" every night.
  It "skips a reload.sh that is not executable"
    topic alpha 0
    chmod -x "$sandbox/alpha/reload.sh"
    When call run_reload
    The status should be success
    The output should not include "alpha reloaded"
  End
End
