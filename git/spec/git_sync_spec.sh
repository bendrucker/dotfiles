#!/usr/bin/env bash
# shellcheck disable=SC2329

Describe "git sync"
  repo_root=$(cd "$SHELLSPEC_PROJECT_ROOT/.." && pwd)
  git_sync="$repo_root/bin/git-sync"

  identify() {
    git -C "$1" config user.email "spec@example.com"
    git -C "$1" config user.name "Spec Runner"
  }

  commit_in() {
    printf '%s\n' "$2" >>"$1/file"
    git -C "$1" add file
    git -C "$1" commit -qm "$2"
  }

  # Commits to a path of its own, so the two sides of a divergence rebase cleanly.
  commit_path_in() {
    printf '%s\n' "$2" >"$1/$2"
    git -C "$1" add "$2"
    git -C "$1" commit -qm "$2"
  }

  head_of() {
    git -C "$1" rev-parse HEAD
  }

  remote_head() {
    git -C "$remote" rev-parse refs/heads/main
  }

  # A bare remote, a clone under test, and a peer clone that moves the remote.
  make_repos() {
    root="$SHELLSPEC_TMPBASE/git-sync/$1"
    remote="$root/remote.git"
    clone="$root/clone"
    peer="$root/peer"

    mkdir -p "$root"
    git init -q --bare --initial-branch=main "$remote"

    git init -q --initial-branch=main "$clone"
    identify "$clone"
    commit_in "$clone" first
    git -C "$clone" remote add origin "$remote"
    git -C "$clone" push -q -u origin main

    git clone -q "$remote" "$peer"
    identify "$peer"
  }

  advance_remote() {
    git -C "$peer" fetch -q origin
    git -C "$peer" merge -q --ff-only origin/main
    commit_in "$peer" "$1"
    git -C "$peer" push -q origin main
  }

  # gum needs a TTY, so the prompting paths are unreachable in CI without a
  # stand-in. GUM_CONFIRM sets the confirm exit status, GUM_CHOOSE is the line
  # `gum choose` returns, and GUM_ARGS_LOG records every call for inspection.
  make_gum_stub() {
    gum_confirm=0
    gum_choose=""
    gum_args_log="$root/gum-args.log"
    stub_bin="$root/stub-bin"

    mkdir -p "$stub_bin"
    : >"$gum_args_log"
    cat >"$stub_bin/gum" <<'STUB'
#!/usr/bin/env bash
command=$1
shift
[[ -z "${GUM_ARGS_LOG:-}" ]] || printf 'gum %s %s\n' "$command" "$*" >>"$GUM_ARGS_LOG"
case "$command" in
  log)
    shift $(($# - 1))
    printf '%s\n' "$1" >&2
    ;;
  spin)
    while [[ $# -gt 0 && $1 != -- ]]; do shift; done
    shift
    "$@"
    ;;
  confirm)
    exit "${GUM_CONFIRM:-0}"
    ;;
  choose)
    [[ -n "${GUM_CHOOSE:-}" ]] || exit 1
    printf '%s\n' "$GUM_CHOOSE"
    ;;
  *)
    exit 1
    ;;
esac
STUB
    chmod +x "$stub_bin/gum"
  }

  # LC_ALL pins git's porcelain wording so output assertions hold on any runner.
  sync_in() {
    dir="$1"
    shift
    (cd "$dir" && LC_ALL=C "$git_sync" "$@")
  }

  sync_with_gum_stub() {
    dir="$1"
    shift
    (
      cd "$dir" &&
        PATH="$stub_bin:$PATH" \
          LC_ALL=C \
          GUM_CONFIRM="$gum_confirm" \
          GUM_CHOOSE="$gum_choose" \
          GUM_ARGS_LOG="$gum_args_log" \
          "$git_sync" "$@"
    )
  }

  It "reports a branch that is already up to date"
    make_repos up-to-date >/dev/null 2>&1
    before=$(head_of "$clone")
    When call sync_in "$clone"
    The status should be success
    The stderr should include "up to date"
    The value "$(head_of "$clone")" should equal "$before"
  End

  It "fast-forwards a clean branch that is only behind"
    make_repos behind >/dev/null 2>&1
    advance_remote theirs >/dev/null 2>&1
    When call sync_in "$clone"
    The status should be success
    The stdout should include "Fast-forward"
    The stderr should include "Fast-forwarded"
    The value "$(head_of "$clone")" should equal "$(remote_head)"
  End

  It "pushes a branch that is only ahead when given --push"
    make_repos ahead >/dev/null 2>&1
    commit_in "$clone" mine >/dev/null 2>&1
    local_head=$(head_of "$clone")
    When call sync_in "$clone" --push
    The status should be success
    The stderr should include "is 1 ahead of"
    The value "$(remote_head)" should equal "$local_head"
  End

  It "refuses to guess on a diverged branch"
    make_repos diverged >/dev/null 2>&1
    commit_in "$clone" mine >/dev/null 2>&1
    advance_remote theirs >/dev/null 2>&1
    before=$(head_of "$clone")
    When call sync_in "$clone"
    The status should be failure
    The stderr should include "has diverged"
    The stderr should include "mine"
    The stderr should include "theirs"
    The value "$(head_of "$clone")" should equal "$before"
  End

  It "refuses a diverged branch with a dirty tree before prompting"
    make_repos diverged-dirty >/dev/null 2>&1
    commit_in "$clone" mine >/dev/null 2>&1
    advance_remote theirs >/dev/null 2>&1
    printf 'uncommitted\n' >>"$clone/file"
    before=$(head_of "$clone")
    When call sync_in "$clone"
    The status should be failure
    The stderr should include "commit or stash your changes"
    The value "$(head_of "$clone")" should equal "$before"
  End

  It "treats an untracked file as a dirty tree"
    make_repos diverged-untracked >/dev/null 2>&1
    commit_in "$clone" mine >/dev/null 2>&1
    advance_remote theirs >/dev/null 2>&1
    printf 'scratch\n' >"$clone/untracked"
    before=$(head_of "$clone")
    When call sync_in "$clone"
    The status should be failure
    The stderr should include "commit or stash your changes"
    The value "$(head_of "$clone")" should equal "$before"
  End

  It "refuses a detached HEAD"
    make_repos detached >/dev/null 2>&1
    git -C "$clone" checkout -q --detach
    before=$(head_of "$clone")
    When call sync_in "$clone"
    The status should be failure
    The stderr should include "detached HEAD"
    The value "$(head_of "$clone")" should equal "$before"
  End

  It "refuses a branch with no upstream when there is no TTY"
    make_repos no-upstream >/dev/null 2>&1
    git -C "$clone" checkout -q -b feature
    before=$(head_of "$clone")
    When call sync_in "$clone"
    The status should be failure
    The stderr should include "no upstream"
    The value "$(head_of "$clone")" should equal "$before"
    The value "$(git -C "$remote" for-each-ref --format='%(refname)' refs/heads/feature)" should equal ""
  End

  It "reports an upstream that was deleted on the remote"
    make_repos deleted-upstream >/dev/null 2>&1
    git -C "$clone" checkout -q -b feature
    git -C "$clone" push -q -u origin feature
    git -C "$peer" push -q --delete origin feature
    before=$(head_of "$clone")
    When call sync_in "$clone"
    The status should be failure
    The stderr should include "is gone from the remote"
    The value "$(head_of "$clone")" should equal "$before"
  End

  It "hands unrecognized arguments to git push"
    make_repos forwarded-args >/dev/null 2>&1
    commit_in "$clone" mine >/dev/null 2>&1
    local_head=$(head_of "$clone")
    When call sync_in "$clone" --push origin main
    The status should be success
    The stderr should include "main -> main"
    The value "$(remote_head)" should equal "$local_head"
  End

  Describe "with prompts answered"
    It "stashes, fast-forwards, and restores a dirty branch that is behind"
      make_repos stash-restore >/dev/null 2>&1
      make_gum_stub >/dev/null 2>&1
      advance_remote theirs >/dev/null 2>&1
      printf 'work in progress\n' >"$clone/wip"
      When call sync_with_gum_stub "$clone"
      The status should be success
      The stdout should include "Fast-forward"
      The stderr should include "with local changes"
      The value "$(head_of "$clone")" should equal "$(remote_head)"
      The value "$(cat "$clone/wip")" should equal "work in progress"
      The value "$(git -C "$clone" stash list)" should equal ""
    End

    It "keeps an unrelated stash when git stash saves nothing"
      make_repos stash-noop >/dev/null 2>&1
      make_gum_stub >/dev/null 2>&1

      # A submodule with only working-tree dirt reads as dirty to git diff, yet
      # git stash push exits 0 without creating an entry. Popping unconditionally
      # would drop the entry below it, which belongs to someone else.
      git init -q --initial-branch=main "$root/submodule" >/dev/null 2>&1
      identify "$root/submodule"
      commit_in "$root/submodule" sub >/dev/null 2>&1
      git -C "$clone" -c protocol.file.allow=always submodule add -q "$root/submodule" sub >/dev/null 2>&1
      git -C "$clone" commit -qm "add submodule"
      git -C "$clone" push -q origin main
      advance_remote theirs >/dev/null 2>&1

      printf 'precious\n' >"$clone/precious"
      git -C "$clone" stash push -q --include-untracked --message "PRECIOUS"
      printf 'dirt\n' >>"$clone/sub/file"

      When call sync_with_gum_stub "$clone"
      The status should be success
      The stdout should include "Fast-forward"
      The stderr should include "nothing was stashed"
      The value "$(head_of "$clone")" should equal "$(remote_head)"
      The value "$(git -C "$clone" stash list)" should include "PRECIOUS"
      The value "$(git -C "$clone" stash list | wc -l | tr -d ' ')" should equal "1"
    End

    It "exits nonzero when the push prompt is declined"
      make_repos push-declined >/dev/null 2>&1
      make_gum_stub >/dev/null 2>&1
      gum_confirm=1
      commit_in "$clone" mine >/dev/null 2>&1
      before=$(remote_head)
      When call sync_with_gum_stub "$clone"
      The status should be failure
      The stderr should include "is 1 ahead of"
      The value "$(remote_head)" should equal "$before"
    End

    It "offers to reset a diverged branch on a bare sync"
      make_repos offers-reset >/dev/null 2>&1
      make_gum_stub >/dev/null 2>&1
      commit_in "$clone" mine >/dev/null 2>&1
      advance_remote theirs >/dev/null 2>&1
      When call sync_with_gum_stub "$clone"
      The status should be failure
      The stderr should include "has diverged"
      The value "$(cat "$gum_args_log")" should include "Reset hard"
    End

    It "withholds the reset option under --push"
      make_repos withholds-reset >/dev/null 2>&1
      make_gum_stub >/dev/null 2>&1
      commit_in "$clone" mine >/dev/null 2>&1
      advance_remote theirs >/dev/null 2>&1
      before=$(head_of "$clone")
      When call sync_with_gum_stub "$clone" --push
      The status should be failure
      The stderr should include "has diverged"
      The value "$(cat "$gum_args_log")" should include "Rebase"
      The value "$(cat "$gum_args_log")" should not include "Reset hard"
      The value "$(head_of "$clone")" should equal "$before"
    End

    It "pushes after rebasing a diverged branch under --push"
      make_repos rebase-then-push >/dev/null 2>&1
      make_gum_stub >/dev/null 2>&1
      commit_path_in "$clone" mine >/dev/null 2>&1
      advance_remote theirs >/dev/null 2>&1
      gum_choose="Rebase 1 commit(s) onto origin/main"
      When call sync_with_gum_stub "$clone" --push
      The status should be success
      The stderr should include "main -> main"
      The value "$(remote_head)" should equal "$(head_of "$clone")"
      The value "$(git -C "$clone" log --format='%s' -2 | tr '\n' ' ')" should equal "mine theirs "
    End

    It "says where to pick up a rebase that stopped on a conflict"
      make_repos rebase-conflict >/dev/null 2>&1
      make_gum_stub >/dev/null 2>&1
      commit_in "$clone" mine >/dev/null 2>&1
      advance_remote theirs >/dev/null 2>&1
      gum_choose="Rebase 1 commit(s) onto origin/main"
      before=$(head_of "$clone")
      remote_before=$(remote_head)
      When call sync_with_gum_stub "$clone" --push
      The status should be failure
      The stdout should include "CONFLICT"
      The stderr should include "rebase stopped"
      The value "$(git -C "$clone" rev-parse refs/heads/main)" should equal "$before"
      The value "$(remote_head)" should equal "$remote_before"
    End
  End
End
