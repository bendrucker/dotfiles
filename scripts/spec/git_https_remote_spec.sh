#!/usr/bin/env bash
# shellcheck disable=SC2329

# shellcheck source=../lib/spin.sh
Include "$SHELLSPEC_PROJECT_ROOT/lib/spin.sh"
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

  # A url.*.insteadOf rule anywhere above the repo decides which transport a
  # fetch uses, so these examples supply the only ones that apply.
  global="$sandbox/gitconfig"
  : >"$global"
  export GIT_CONFIG_GLOBAL="$global"
  export GIT_CONFIG_SYSTEM=/dev/null
}

BeforeEach 'setup'

# What an org that standardizes on SSH installs. It undoes an HTTPS remote.
force_ssh() {
  git config --file "$global" "url.git@github.com:.insteadOf" "https://github.com/"
}

fetch_url() { git -C "$repo" config --get remote.origin.url; }
push_url() { git -C "$repo" config --get "remote.origin.pushurl"; }
stored_push_url() { push_url || true; }
effective_url() { git -C "$repo" ls-remote --get-url origin; }
pin_key="url.https://github.com/bendrucker/claude.git.insteadOf"
pin() { git -C "$repo" config --get "$pin_key" || true; }
pins() { git -C "$repo" config --get-all "$pin_key" || true; }
pin_count() { pins | grep -cxF "https://github.com/bendrucker/claude.git" | tr -d ' '; }

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

  # Regression: a remote already stored as HTTPS looks done, and every 3am fetch
  # still went out over SSH and died on "agent refused operation", because the
  # rule rewrote it on the way out.
  It "holds an https remote on HTTPS against a rule mapping it back to SSH"
    force_ssh
    When call rewrite "https://github.com/bendrucker/claude.git"
    The output should equal "https://github.com/bendrucker/claude.git"
    The result of function effective_url should equal "https://github.com/bendrucker/claude.git"
    The stderr should include "Pinning origin"
  End

  It "rewrites and pins an ssh remote when the rule is present"
    force_ssh
    When call rewrite "git@github.com:bendrucker/claude.git"
    The output should equal "https://github.com/bendrucker/claude.git"
    The result of function effective_url should equal "https://github.com/bendrucker/claude.git"
  End

  # The pin takes the rule out of the fetch path, and a push that was going over
  # SSH has to keep going there. Its credentials are set up for that transport.
  It "keeps pushes on SSH when it pins the fetch"
    force_ssh
    When call rewrite "https://github.com/bendrucker/claude.git"
    The output should equal "https://github.com/bendrucker/claude.git"
    The result of function push_url should equal "git@github.com:bendrucker/claude.git"
  End

  # Only the stored url decides. A rule that sends another host to github does
  # not make this a github remote, and acting on one whose replacement drops the
  # repo path would store a url naming a repository that does not exist.
  It "leaves a non-github remote alone when a rule sends it to github"
    git config --file "$global" "url.https://github.com/.insteadOf" "https://"
    When call rewrite "https://bitbucket.org/bendrucker/private.git"
    The output should equal "https://bitbucket.org/bendrucker/private.git"
    The result of function pin should equal ""
    The stderr should not include "Pinning"
  End

  # A mirror or proxy rule can be the only route out of a network. Pinning past
  # it would bypass it for fetches and aim pushes at a mirror that may be read
  # only, and neither has anything to do with an agent that will not sign.
  It "leaves a rule routing the remote to another https host in place"
    git config --file "$global" \
      "url.https://mirror.corp.example/github/.insteadOf" "https://github.com/"
    When call rewrite "https://github.com/bendrucker/claude.git"
    The output should equal "https://github.com/bendrucker/claude.git"
    The result of function effective_url should equal "https://mirror.corp.example/github/bendrucker/claude.git"
    The result of function stored_push_url should equal ""
    The stderr should not include "Pinning"
  End

  # Most machines have no such rule. Writing the pin anyway would leave an
  # unexplained url.*.insteadOf in every repo the nightly job touches.
  It "writes no pin when nothing rewrites the url"
    When call rewrite "git@github.com:bendrucker/claude.git"
    The output should equal "https://github.com/bendrucker/claude.git"
    The result of function pin should equal ""
    The stderr should not include "Pinning"
  End

  # insteadOf is multi-valued. A plain write refuses a key already carrying two
  # rules, which left the pin unwritten and the fetch back on SSH.
  It "pins alongside existing rules on the key it claims"
    force_ssh
    git config --file "$global" "url.git@github.com:.insteadOf" "https://git.example.com/" --add
    git -C "$repo" config --add "$pin_key" "https://mirror.example/"
    git -C "$repo" config --add "$pin_key" "https://mirror2.example/"
    When call rewrite "https://github.com/bendrucker/claude.git"
    The output should equal "https://github.com/bendrucker/claude.git"
    The result of function effective_url should equal "https://github.com/bendrucker/claude.git"
    The result of function pins should include "https://mirror.example/"
    The result of function pins should include "https://mirror2.example/"
  End

  # A rule of equal length registered earlier wins the tie, so this pin never
  # takes. It has to stop trying rather than grow .git/config a line a night.
  rewrite_thrice() {
    git -C "$repo" remote add origin "$1"
    PATH="$stubdir:$PATH" git_https_remote "$repo"
    PATH="$stubdir:$PATH" git_https_remote "$repo"
    PATH="$stubdir:$PATH" git_https_remote "$repo"
    fetch_url
  }

  It "adds the pin once when an equal-length rule outranks it"
    git config --file "$global" \
      "url.git@github.com:bendrucker/claude.git.insteadOf" \
      "https://github.com/bendrucker/claude.git"
    When call rewrite_thrice "https://github.com/bendrucker/claude.git"
    The output should equal "https://github.com/bendrucker/claude.git"
    The result of function pin_count should equal "1"
    The stderr should include "still resolves to"
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
