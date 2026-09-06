#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2329
#
# bin/git-sync is the command form of scripts/lib/git-sync.sh, for the
# TypeScript callers that cannot source it. The library's own behaviour is
# covered by git_https_remote_spec.sh. These cover the boundary: the three
# status codes a caller reads instead of $GIT_SYNC_*, and the environment
# git_https_env would have exported, printed instead so the caller can scope it
# to the children that need it.

Describe "bin/git-sync"
  script="$SHELLSPEC_PROJECT_ROOT/../bin/git-sync"

  setup() {
    root=$(mktemp -d)
    stub_gum "$root"
    repo="$root/repo"
    origin="$root/origin"

    git init -q --bare "$origin"
    git init -q -b main "$repo"
    git -C "$repo" config user.email spec@example.com
    git -C "$repo" config user.name Spec
    git -C "$repo" commit -q --allow-empty -m first
    git -C "$repo" remote add origin "$origin"
    git -C "$repo" push -q origin main
    git -C "$repo" branch -q --set-upstream-to origin/main main
  }

  cleanup() {
    rm -rf "$root"
  }

  BeforeEach 'setup'
  AfterEach 'cleanup'

  # env -u, because the sandbox this suite can run under sets its own
  # GIT_CONFIG entries, and https-env reports whatever it is appending to.
  run_git_sync() {
    env -u GIT_CONFIG_COUNT PATH="$root:$PATH" "$script" "$@"
  }

  Describe "sync"
    # 2 rather than 0, because a caller has to tell "nothing to do" from
    # "updated" to decide whether its post-update side effects should run.
    It "reports an unmoved clone as current"
      When run run_git_sync sync "$repo" main
      The status should equal 2
      The stderr should be present
    End

    It "prints the new short rev when the clone moves"
      moved() {
        local scratch="$root/scratch"
        git clone -q "$origin" "$scratch"
        git -C "$scratch" config user.email spec@example.com
        git -C "$scratch" config user.name Spec
        git -C "$scratch" commit -q --allow-empty -m second
        git -C "$scratch" push -q origin main
        PATH="$root:$PATH" "$script" sync "$repo" main
      }
      When run moved
      The status should equal 0
      The output should equal "$(git -C "$origin" rev-parse --short main)"
      The stderr should be present
    End

    It "fails on a directory that is not a repository"
      When run run_git_sync sync "$root" main
      The status should equal 1
      The stderr should include "not a git repository"
    End

    # The guard that keeps an unattended sync from discarding work in progress.
    It "fails on a dirty tree"
      dirty() {
        echo change >"$repo/file"
        git -C "$repo" add file
        PATH="$root:$PATH" "$script" sync "$repo" main
      }
      When run dirty
      The status should equal 1
      The stderr should include "local changes"
    End
  End

  Describe "https-env"
    It "prints both SSH prefixes as insteadOf rules"
      When run run_git_sync https-env
      The status should be success
      The output should include "GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf"
      The output should include "GIT_CONFIG_VALUE_0=git@github.com:"
      The output should include "GIT_CONFIG_VALUE_1=ssh://git@github.com/"
      The output should include "GIT_CONFIG_COUNT=2"
    End

    # A machine-local GIT_CONFIG entry has to survive, so the rules are
    # appended at the next free index rather than written over index 0.
    It "appends to entries already in the environment"
      with_existing() {
        GIT_CONFIG_COUNT=1 \
          GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=/somewhere \
          PATH="$root:$PATH" "$script" https-env
      }
      When run with_existing
      The output should include "GIT_CONFIG_KEY_0=safe.directory"
      The output should include "GIT_CONFIG_KEY_1=url.https://github.com/.insteadOf"
      The output should include "GIT_CONFIG_COUNT=3"
    End
  End

  Describe "default-branch"
    # The fixture is built by hand and has no refs/remotes/origin/HEAD, which
    # is the path that takes the set-head retry. That retry announces itself on
    # stdout, so before it was silenced this answered with its own confirmation
    # line above the branch name, and every caller reads this through command
    # substitution.
    It "names the branch a sync would target"
      When run run_git_sync default-branch "$repo"
      The status should be success
      The output should equal "main"
    End
  End

  It "rejects an unknown subcommand"
    When run run_git_sync frobnicate
    The status should equal 2
    The stderr should include "usage:"
  End
End
