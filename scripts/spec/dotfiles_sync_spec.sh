#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "dotfiles-sync exit status"
  dotfiles_sync="$SHELLSPEC_PROJECT_ROOT/../bin/dotfiles-sync"

  setup() {
    sandbox="$SHELLSPEC_TMPBASE/dotfiles-sync"
    origin="$sandbox/origin.git"
    repo="$sandbox/repo"
    stubdir="$sandbox/stub"
    rm -rf "$sandbox"
    mkdir -p "$stubdir"

    stub_gum "$stubdir"
    stub_osascript "$stubdir"

    # Bare origin with one commit on main; clone so HEAD == origin/main.
    git init -q --bare -b main "$origin"
    git init -q -b main "$repo"
    git -C "$repo" -c user.email=test@example.com -c user.name=test \
      commit -q --allow-empty -m init
    git -C "$repo" remote add origin "$origin"
    git -C "$repo" push -q origin main
    git -C "$repo" remote set-head origin main
  }

  # Run with `zsh -f` so the script's startup skips ~/.zshenv, which exports
  # DOTFILES_HOME unconditionally and would otherwise clobber the sandbox path.
  run_sync() {
    PATH="$stubdir:$PATH" DOTFILES_HOME="$repo" zsh -f "$dotfiles_sync"
  }

  BeforeEach 'setup'

  # Regression: under `set -e`, the already-current path (git_sync returns 2)
  # must map to exit 0, not abort the script with the raw "current" code.
  It "exits 0 when the repo is already up to date"
    When call run_sync
    The status should be success
    The stderr should include "Already up to date"
  End

  # A dirty working tree is caught by git_review_dirty before the sync. Without a
  # TTY (as here) it renders the diff, notifies, and aborts with a nonzero exit.
  It "exits 1 when the working tree is dirty"
    touch "$repo/dirty"
    git -C "$repo" add dirty
    When call run_sync
    The status should equal 1
    The stderr should include "Local changes present"
  End
End
