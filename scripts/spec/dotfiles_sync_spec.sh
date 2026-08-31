#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016

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
    printf 'tracked\n' >"$repo/file.txt"
    git -C "$repo" add file.txt
    git -C "$repo" -c user.email=test@example.com -c user.name=test \
      commit -q -m init
    git -C "$repo" remote add origin "$origin"
    git -C "$repo" push -q origin main
    git -C "$repo" remote set-head origin main
  }

  # Land a commit on origin that the clone has not pulled, so origin/main
  # carries a rule this checkout has no way to know about yet.
  push_ignore_rule() {
    local rule="$1" upstream="$sandbox/upstream"
    rm -rf "$upstream"
    git clone -q "$origin" "$upstream"
    printf '%s\n' "$rule" >"$upstream/.gitignore"
    git -C "$upstream" add .gitignore
    git -C "$upstream" -c user.email=test@example.com -c user.name=test \
      commit -q -m "ignore $rule"
    git -C "$upstream" push -q origin main
  }

  # gum prefixes each line with the level, as the real gum does with no --time
  # set. The shared stub drops it, and the fingerprint this locks is read off it.
  stub_gum_levels() {
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
      '    case "$3" in' \
      '      warn)  level=WARN ;;' \
      '      error) level=ERRO ;;' \
      '      *)     level=INFO ;;' \
      '    esac' \
      '    printf "%s %s\n" "$level" "${@: -1}" >&2' \
      '    ;;' \
      'esac' \
      > "$1/gum"
    chmod +x "$1/gum"
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

  # The rule and the files it covers ship in the same commit, so the rule can
  # only reach this checkout through the pull the gate is blocking. Judged
  # against the .gitignore on disk the tree stays dirty every night forever.
  It "syncs past an untracked path the incoming .gitignore covers"
    push_ignore_rule 'scratch/'
    mkdir -p "$repo/scratch"
    printf 'note\n' >"$repo/scratch/note.txt"
    When call run_sync
    The status should be success
    The stderr should include "ignored by the incoming .gitignore"
  End

  # .gitignore says nothing about a path git already tracks, so nothing the pull
  # carries may wave one through.
  It "still blocks a tracked modification"
    push_ignore_rule 'scratch/'
    printf 'edited\n' >>"$repo/file.txt"
    When call run_sync
    The status should equal 1
    The stderr should include "Local changes present"
  End

  It "still blocks an untracked path neither .gitignore covers"
    push_ignore_rule 'scratch/'
    printf 'stray\n' >"$repo/stray.txt"
    When call run_sync
    The status should equal 1
    The stderr should include "Local changes present"
  End

  # `git diff HEAD` names no untracked file, so the report of a block over one
  # used to carry an empty diff.
  It "renders the diff of an untracked file"
    printf 'stray\n' >"$repo/stray.txt"
    When call run_sync
    The status should equal 1
    The stderr should include "+++ b/stray.txt"
    The stderr should include "+stray"
  End

  # report_upgrade_failure fingerprints on fields 2-4 of the WARN and ERRO lines,
  # and "Local changes present - skipping sync" reads the same whatever is dirty.
  # The paths need a line of their own, or a block recurring over a different
  # dirty set files no to-do after the first and the deadlock goes silent.
  It "puts the blocking paths in fields 2-4 of a line of their own"
    stub_gum_levels "$stubdir"
    printf 'stray\n' >"$repo/stray.txt"
    When call run_sync
    The status should equal 1
    The stderr should include "WARN stray.txt"
  End
End
