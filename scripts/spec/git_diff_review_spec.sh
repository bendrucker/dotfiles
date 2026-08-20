#!/usr/bin/env bash
# notified is consumed by a shellspec matcher the linter cannot see, and the
# stub functions read as unused.
# shellcheck disable=SC2034,SC2329,SC2016
#
# git_review_open_pr is the one path that pushes a dirty deploy checkout to a
# remote, and both repos it serves are public. Vibe Island writes this
# machine's name into settings.json as part of a hook command, so the changes
# this path captures are exactly the ones that can carry it. These lock the
# refusal, and lock the commit message that used to publish the host by design.
#
# A real temp repo with a bare origin, so the branch, commit, and push are the
# real ones. Only gum, gh, and hostname are stubbed.

Describe "git_review_open_pr"
  setup() {
    sandbox="$SHELLSPEC_TMPBASE/git-diff-review"
    stubdir="$sandbox/stub"
    repo="$sandbox/repo"
    rm -rf "$sandbox"
    mkdir -p "$stubdir"

    stub_gum "$stubdir"

    export GH_LOG="$sandbox/gh.log"
    : >"$GH_LOG"
    # printf, not a here-document: bash stages those through a temp file it
    # picks itself, which a sandbox may deny.
    printf '%s\n' \
      '#!/usr/bin/env bash' \
      'printf "%s\n" "$*" >>"$GH_LOG"' \
      'printf "https://example.test/pr/1\n"' \
      >"$stubdir/gh"
    chmod +x "$stubdir/gh"

    # `hostname -s` and `hostname` differ on a real machine, and the guard has
    # to cover both.
    printf '%s\n' \
      '#!/usr/bin/env bash' \
      '[ "$1" = "-s" ] && { printf "spechost\n"; exit 0; }' \
      'printf "spechost.example.test\n"' \
      >"$stubdir/hostname"
    chmod +x "$stubdir/hostname"

    # macOS keeps the Cocoa-facing name separately, and a user can set it to
    # something the POSIX hostname does not contain. HostName is commonly unset,
    # which scutil reports as a failure with nothing on stdout.
    printf '%s\n' \
      '#!/usr/bin/env bash' \
      'case "$2" in' \
      '  ComputerName)  printf "Spec Machine\n" ;;' \
      '  LocalHostName) printf "spechost\n" ;;' \
      '  *)             exit 1 ;;' \
      'esac' \
      >"$stubdir/scutil"
    chmod +x "$stubdir/scutil"

    PATH="$stubdir:$PATH"

    git init -q --bare "$sandbox/origin.git"
    git init -q -b main "$repo"
    git -C "$repo" config user.email spec@example.test
    git -C "$repo" config user.name Spec
    git -C "$repo" config commit.gpgsign false
    git -C "$repo" remote add origin "$sandbox/origin.git"
    printf 'tracked\n' >"$repo/file.txt"
    git -C "$repo" add -A
    git -C "$repo" commit -q -m initial
    git -C "$repo" push -q -u origin main

    # shellcheck source=/dev/null
    source "$SHELLSPEC_PROJECT_ROOT/lib/git-sync.sh"
    # shellcheck source=/dev/null
    source "$SHELLSPEC_PROJECT_ROOT/lib/git-diff-review.sh"
    notified=""
  }
  BeforeEach 'setup'

  # Overrides the notify sourced above, so a test reads what the caller was
  # told without reaching osascript.
  notify() { notified="$1: $2"; }

  sync_branches() { git -C "$repo" branch --list 'sync/*'; }
  head_subject() { git -C "$repo" log -1 --format=%s --branches='sync/*'; }

  Describe "changes that name this machine"
    It "refuses the short name"
      printf 'ran on spechost\n' >"$repo/file.txt"
      When call git_review_open_pr "$repo" "Title"
      The status should be failure
      The variable notified should include "name this machine"
      The stderr should include "refusing to push"
    End

    It "refuses the fully qualified name"
      printf 'ran on spechost.example.test\n' >"$repo/file.txt"
      When call git_review_open_pr "$repo" "Title"
      The status should be failure
      The stderr should be defined
    End

    # Vibe Island writes the host lowercased into the hook command while the
    # machine reports it capitalized, so an exact match would miss it.
    It "refuses a name in another case"
      printf 'ran on SPECHOST\n' >"$repo/file.txt"
      When call git_review_open_pr "$repo" "Title"
      The status should be failure
      The stderr should be defined
    End

    # git add -A commits untracked files too, so a guard reading only the
    # tracked diff would wave through a file an app just dropped in.
    It "refuses an untracked file whose contents name it"
      printf 'ran on spechost\n' >"$repo/dropped.txt"
      When call git_review_open_pr "$repo" "Title"
      The status should be failure
      The stderr should be defined
    End

    It "refuses an untracked file whose own name names it"
      printf 'unremarkable\n' >"$repo/spechost-diagnostics.txt"
      When call git_review_open_pr "$repo" "Title"
      The status should be failure
      The stderr should be defined
    End

    # An app asking Cocoa for the computer's name gets this one, which the
    # POSIX hostname need not contain.
    It "refuses the Cocoa computer name"
      printf 'ran on Spec Machine\n' >"$repo/file.txt"
      When call git_review_open_pr "$repo" "Title"
      The status should be failure
      The stderr should be defined
    End

    It "leaves the tree and the branches untouched"
      printf 'ran on spechost\n' >"$repo/file.txt"
      When call git_review_open_pr "$repo" "Title"
      The status should be failure
      The result of function sync_branches should equal ""
      The contents of file "$GH_LOG" should equal ""
      The contents of file "$repo/file.txt" should equal "ran on spechost"
    End
  End

  # Vibe Island writes on its own schedule, so the tree can gain the machine's
  # name after the first check has already passed. The `git` stub writes it in
  # on the `add`, standing in for that timing.
  Describe "a change that arrives mid-flight"
    It "refuses once the tree is staged"
      printf 'unremarkable\n' >"$repo/file.txt"
      printf '%s\n' \
        '#!/usr/bin/env bash' \
        'for a in "$@"; do' \
        '  [ "$a" = add ] && printf "ran on spechost\n" >>"$REPO/file.txt"' \
        'done' \
        'exec /usr/bin/git "$@"' \
        >"$stubdir/git"
      chmod +x "$stubdir/git"
      export REPO="$repo"
      # setup ran git before this stub existed, so bash has the real path
      # cached and would keep using it.
      hash -r

      When call git_review_open_pr "$repo" "Title"
      The status should be failure
      The variable notified should include "name this machine"
      The stderr should include "refusing to push"
      The contents of file "$GH_LOG" should equal ""
      The output should be defined
    End
  End

  Describe "changes that do not"
    # The machine's name is short, so an unanchored match would find it inside
    # unrelated words and refuse a sync over nothing.
    It "allows a name embedded in a longer word"
      printf 'the spechostname helper and a spechosting provider\n' >"$repo/file.txt"
      When call git_review_open_pr "$repo" "Title"
      The status should be success
      The contents of file "$GH_LOG" should include "pr create"
      The stderr should be defined
      The output should be defined
    End

    It "opens the PR"
      printf 'unremarkable\n' >"$repo/file.txt"
      When call git_review_open_pr "$repo" "Title"
      The status should be success
      The contents of file "$GH_LOG" should include "pr create"
      The variable notified should include "Opened PR"
      The stderr should be defined
      The output should be defined
    End

    # The message used to carry `hostname -s`, publishing the host on every
    # sync. The branch name already dates the run.
    It "commits without naming the machine"
      printf 'unremarkable\n' >"$repo/file.txt"
      When call git_review_open_pr "$repo" "Title"
      The status should be success
      The result of function head_subject should equal "sync: local changes captured"
      The stderr should be defined
      The output should be defined
    End
  End
End
