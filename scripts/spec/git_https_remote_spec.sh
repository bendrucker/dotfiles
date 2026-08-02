#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "git_https_remote"
  setup() {
    sandbox="$SHELLSPEC_TMPBASE/git-https-remote"
    repo="$sandbox/repo"
    stubdir="$sandbox/stub"
    rm -rf "$sandbox"
    mkdir -p "$stubdir"

    # The real gum log writes to stderr. Nothing here asserts on it.
    printf '#!/usr/bin/env bash\nexit 0\n' > "$stubdir/gum"
    chmod +x "$stubdir/gum"

    git init -q -b main "$repo"
  }

  BeforeEach 'setup'

  # shellcheck source=../lib/git-sync.sh
  Include "$SHELLSPEC_PROJECT_ROOT/lib/git-sync.sh"

  rewrite() {
    git -C "$repo" remote add origin "$1"
    PATH="$stubdir:$PATH" git_https_remote "$repo"
    git -C "$repo" remote get-url origin
  }

  It "rewrites an scp-style github remote"
    When call rewrite "git@github.com:bendrucker/claude.git"
    The output should equal "https://github.com/bendrucker/claude.git"
  End

  It "rewrites an ssh:// github remote"
    When call rewrite "ssh://git@github.com/bendrucker/claude.git"
    The output should equal "https://github.com/bendrucker/claude.git"
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
End

Describe "git_https_env"
  # shellcheck source=../lib/git-sync.sh
  Include "$SHELLSPEC_PROJECT_ROOT/lib/git-sync.sh"

  setup() {
    repo="$SHELLSPEC_TMPBASE/git-https-env"
    rm -rf "$repo"
    git init -q -b main "$repo"
  }

  BeforeEach 'setup'

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
