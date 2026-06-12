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

    # gum stub: `gum spin … -- cmd` runs cmd; `gum log … msg` echoes msg.
    cat > "$stubdir/gum" <<'GUM'
#!/usr/bin/env bash
case "$1" in
  spin)
    shift
    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
    [ "$1" = "--" ] && shift
    exec "$@"
    ;;
  log)
    # Real gum log writes to stderr; match that so command substitution in
    # callers keeps log lines off the captured stdout rev.
    printf '%s\n' "${@: -1}" >&2
    ;;
esac
GUM
    chmod +x "$stubdir/gum"

    # notify shells out to osascript on macOS; stub it so the failure path
    # stays silent and side-effect-free during the test.
    printf '#!/usr/bin/env bash\nexit 0\n' > "$stubdir/osascript"
    chmod +x "$stubdir/osascript"

    # Bare origin with one commit on main; clone so HEAD == origin/main.
    git init -q --bare -b main "$origin"
    git init -q -b main "$repo"
    git -C "$repo" -c user.email=test@example.com -c user.name=test \
      commit -q --allow-empty -m init
    git -C "$repo" remote add origin "$origin"
    git -C "$repo" push -q origin main
    git -C "$repo" remote set-head origin main
  }

  run_sync() {
    PATH="$stubdir:$PATH" DOTFILES_HOME="$repo" "$dotfiles_sync"
  }

  BeforeEach 'setup'

  # Regression: under `set -e`, the already-current path (git_sync returns 2)
  # must map to exit 0, not abort the script with the raw "current" code.
  It "exits 0 when the repo is already up to date"
    When call run_sync
    The status should be success
    The stderr should include "Already up to date"
  End

  # The other side of the case block: a guard failure (git_sync returns 1) must
  # surface as a nonzero exit.
  It "exits 1 when the working tree is dirty"
    touch "$repo/dirty"
    git -C "$repo" add dirty
    When call run_sync
    The status should equal 1
    The stderr should include "has local changes"
  End
End
