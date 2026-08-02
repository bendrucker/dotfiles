#!/usr/bin/env bash
# shellcheck disable=SC2329

# shellcheck source=../lib/git-sync.sh
Include "$SHELLSPEC_PROJECT_ROOT/lib/git-sync.sh"

setup() {
  sandbox="$SHELLSPEC_TMPBASE/git-https"
  repo="$sandbox/repo"
  stubdir="$sandbox/stub"
  rm -rf "$sandbox"
  mkdir -p "$stubdir"
  stub_gum "$stubdir"
  git init -q -b main "$repo"
}

BeforeEach 'setup'

fetch_url() { git -C "$repo" config --get remote.origin.url; }
push_url() { git -C "$repo" config --get "remote.origin.pushurl"; }

Describe "git_https_remote"
  rewrite() {
    git -C "$repo" remote add origin "$1"
    PATH="$stubdir:$PATH" git_https_remote "$repo"
    fetch_url
  }

  It "rewrites an scp-style github remote"
    When call rewrite "git@github.com:bendrucker/claude.git"
    The output should equal "https://github.com/bendrucker/claude.git"
    The stderr should include "pushing over SSH"
  End

  It "rewrites an ssh:// github remote"
    When call rewrite "ssh://git@github.com/bendrucker/claude.git"
    The output should equal "https://github.com/bendrucker/claude.git"
    The stderr should include "pushing over SSH"
  End

  It "leaves an https github remote alone"
    When call rewrite "https://github.com/bendrucker/claude.git"
    The output should equal "https://github.com/bendrucker/claude.git"
  End

  # Only github.com is public enough to fetch anonymously. A work host keeps
  # whatever transport its credentials are set up for.
  It "leaves a non-github ssh remote alone"
    When call rewrite "git@gitlab.com:bendrucker/private.git"
    The output should equal "git@gitlab.com:bendrucker/private.git"
  End

  It "does nothing when the remote is missing"
    When call git_https_remote "$repo"
    The status should be success
  End

  # Only the fetch URL moves. Pushing over anonymous HTTPS would need
  # credentials the SSH remote already had.
  It "keeps the SSH url for pushes"
    When call rewrite "git@github.com:bendrucker/claude.git"
    The output should equal "https://github.com/bendrucker/claude.git"
    The result of function push_url should equal "git@github.com:bendrucker/claude.git"
  End

  It "does not clobber a pushurl that is already set"
    git -C "$repo" remote add origin "git@github.com:bendrucker/claude.git"
    git -C "$repo" remote set-url --push origin "git@github.com:someone/fork.git"
    When call env PATH="$stubdir:$PATH" git_https_remote "$repo"
    The result of function push_url should equal "git@github.com:someone/fork.git"
  End

  # Regression: `git remote get-url` resolves insteadOf rules, so reading the
  # remote through it reports HTTPS while .git/config still holds SSH, and the
  # rewrite silently never happens.
  It "still rewrites when an insteadOf rule already maps the url"
    git_https_env
    When call rewrite "git@github.com:bendrucker/claude.git"
    The output should equal "https://github.com/bendrucker/claude.git"
    The stderr should include "pushing over SSH"
  End
End

Describe "git_https_env"
  resolved_url() {
    git -C "$repo" remote add origin "$1"
    git_https_env
    git -C "$repo" ls-remote --get-url origin
  }

  It "rewrites github SSH urls for child git processes"
    When call resolved_url "git@github.com:bendrucker/claude.git"
    The output should equal "https://github.com/bendrucker/claude.git"
  End

  # A ~/.zshenv.local can export its own GIT_CONFIG entries. Overwriting index
  # 0 and pinning the count at 2 would silently drop them.
  It "appends to inherited GIT_CONFIG entries"
    export GIT_CONFIG_COUNT=1
    export GIT_CONFIG_KEY_0=core.pager
    export GIT_CONFIG_VALUE_0=cat
    When call resolved_url "git@github.com:bendrucker/claude.git"
    The output should equal "https://github.com/bendrucker/claude.git"
    The variable GIT_CONFIG_COUNT should equal 3
    The variable GIT_CONFIG_VALUE_0 should equal cat
  End
End
