#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016
#
# Locks the wt-prune removal invariants against a silent detection regression:
# the classify_survivor decision matrix (the source of truth for what gets
# removed), parse_duration, the standalone --dry-run reasons table, and the
# wt-prune-audit drift oracle. classify_survivor and parse_duration are
# exercised by sourcing bin/wt-prune under the ZSH_EVAL_CONTEXT guard, which
# defines the functions without running the prune. The dry-run and audit cases
# are black-box: PATH-shim stubs for wt/gh/gum feed canned wt list and gh pr
# view state to the real script, following scripts/spec/dotfiles_sync_spec.sh.

wtprune="$SHELLSPEC_PROJECT_ROOT/../bin/wt-prune"
wtaudit="$SHELLSPEC_PROJECT_ROOT/../bin/wt-prune-audit"

# Preserve empty positional args (a survivor with no PR passes "" for pr_state),
# which `classify_survivor $*` would drop. The leading _ is $0 for `zsh -c`.
run_classify() { zsh -fc 'source "$1"; shift; classify_survivor "$@"' _ "$wtprune" "$@"; }
run_parse()    { zsh -fc 'source "$1"; shift; parse_duration "$@"'    _ "$wtprune" "$@"; }

Describe "classify_survivor decision matrix"
  # pr_state onremote clean is_current before age  -> action  reason
  Parameters
    # Case 1 & 2: merged wins over a dirty tree and local commits ahead. A
    # squash merge leaves both, so only the MERGED forge state proves it landed.
    "MERGED"  "local"    "dirty"  "false"  1  1  "remove"  "merged"
    "MERGED"  "onremote" "clean"  "false"  0  0  "remove"  "merged"
    # Case 3: closed, backed up on a remote, clean -> recoverable, remove.
    "CLOSED"  "onremote" "clean"  "false"  0  0  "remove"  "closed, recoverable"
    # Case 4: closed but local-only or dirty -> keep, the work is only here.
    "CLOSED"  "local"    "clean"  "false"  0  0  "keep"    "local-only"
    "CLOSED"  "onremote" "dirty"  "false"  0  0  "keep"    "dirty & closed"
    # Case 5: an open PR is preserved.
    "OPEN"    "onremote" "clean"  "false"  0  0  "keep"    "open PR"
    # Case 6: the current worktree is never force-removed, even when merged.
    "MERGED"  "local"    "dirty"  "true"   0  0  "keep"    "current worktree"
    # Case 7: pushed with no PR and not yet aged -> defer, do not auto-remove.
    # NOPR is the sentinel for an empty pr_state (a survivor with no PR).
    "NOPR"    "onremote" "clean"  "false"  1  0  "defer"   "local-only"
    # Age pass: old and clean with no decisive PR state -> remove, keep branch.
    "NOPR"    "local"    "clean"  "false"  1  1  "remove"  "aged out"
    # Age applies whatever the PR state: an old, clean open-PR checkout ages out.
    "OPEN"    "onremote" "clean"  "false"  1  1  "remove"  "aged out"
  End

  Example "$1/$2/$3 current=$4 before=$5 age=$6 -> $7 ($8)"
    pr="$1"; [ "$pr" = NOPR ] && pr=""
    When call run_classify "$pr" "$2" "$3" "$4" "$5" "$6"
    The output should equal "$(printf '%s\t%s' "$7" "$8")"
    The status should be success
  End
End

Describe "parse_duration"
  It "converts 2w to seconds"
    When call run_parse 2w
    The output should equal 1209600
    The status should be success
  End

  It "fails on an unknown spec so callers fall back to a default"
    When call run_parse bogus
    The status should be failure
    The output should equal ""
  End
End

Describe "wt-prune --dry-run and wt-prune-audit (black-box)"
  setup() {
    sandbox="$SHELLSPEC_TMPBASE/wt-prune"
    repo="$sandbox/repo"
    stubdir="$sandbox/stub"
    export WT_LIST_JSON="$sandbox/list.json"
    export WT_REMOVE_LOG="$sandbox/removed.log"
    export PR_STATE_FILE="$sandbox/pr_state"
    rm -rf "$sandbox"
    mkdir -p "$stubdir"
    : >"$WT_REMOVE_LOG"

    # wt stub: `step prune` probe reports nothing integrated (so the survivor
    # reaches the forge pass); `list` emits the canned fixture; `remove` only
    # logs, so a dry-run that wrongly removed would leave a trace here.
    cat >"$stubdir/wt" <<'WT'
#!/usr/bin/env bash
case "$1" in
  step)   echo "[]" ;;
  list)   cat "$WT_LIST_JSON" ;;
  remove) printf 'remove %s\n' "$*" >>"$WT_REMOVE_LOG" ;;
esac
exit 0
WT
    chmod +x "$stubdir/wt"

    # gh stub: `gh pr view <branch> --json state,number --jq …` resolves to the
    # state under test. pr_state formats it as "STATE\tNUMBER".
    cat >"$stubdir/gh" <<'GH'
#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\t42\n' "$(cat "$PR_STATE_FILE")"
fi
exit 0
GH
    chmod +x "$stubdir/gh"

    # gum stub: unused on the non-interactive path, present so an accidental
    # call cannot escape to the real binary.
    printf '#!/usr/bin/env bash\nexit 0\n' >"$stubdir/gum"
    chmod +x "$stubdir/gum"

    # A real repo with a github origin, so `git remote get-url origin` routes
    # pr_state to the gh path. Worktree contents are canned in the fixture.
    git init -q -b main "$repo"
    git -C "$repo" -c user.email=test@example.com -c user.name=test \
      commit -q --allow-empty -m init
    git -C "$repo" remote add origin "https://github.com/test/repo.git"

    printf 'MERGED' >"$PR_STATE_FILE"
  }
  BeforeEach 'setup'

  # A merged survivor whose branch main_state still diverges (the squash-merge
  # shape): the integration pass misses it, the forge state carries the removal.
  fixture_merged_survivor() {
    cat >"$WT_LIST_JSON" <<'JSON'
[
  {"kind":"worktree","branch":"main","is_main":true,"is_current":true,
   "path":"/repo","main_state":"is_main","commit":{"timestamp":0},
   "working_tree":{"staged":false,"modified":false,"untracked":false,"renamed":false,"deleted":false},
   "remote":{"ahead":0,"behind":0}},
  {"kind":"worktree","branch":"feature-x","is_main":false,"is_current":false,
   "path":"/repo/.worktrees/feature-x","main_state":"diverged","commit":{"timestamp":1000},
   "working_tree":{"staged":false,"modified":false,"untracked":false,"renamed":false,"deleted":false},
   "remote":{"ahead":0,"behind":0}}
]
JSON
  }

  run_prune() { ( cd "$repo" && PATH="$stubdir:$PATH" zsh "$wtprune" "$@" ); }
  run_audit() { ( cd "$repo" && PATH="$stubdir:$PATH" zsh "$wtaudit" ); }

  It "dry-run prints a reasons table and removes nothing"
    fixture_merged_survivor
    When call run_prune --dry-run
    The status should be success
    The output should include "DECISION"
    The output should include "REASON"
    The output should include "feature-x"
    The output should include "remove"
    The output should include "merged"
    The contents of file "$WT_REMOVE_LOG" should equal ""
  End

  It "dry-run -i refuses without a terminal and removes nothing"
    fixture_merged_survivor
    When call run_prune --dry-run -i
    The status should equal 1
    The stderr should include "requires a terminal"
    The contents of file "$WT_REMOVE_LOG" should equal ""
  End

  It "audit flags a merged survivor the prune left behind"
    fixture_merged_survivor
    printf 'MERGED' >"$PR_STATE_FILE"
    When call run_audit
    The status should be success
    The line 1 of output should equal "$(printf 'feature-x\tmerged PR survived')"
  End

  It "audit flags an integrated survivor without a forge call"
    cat >"$WT_LIST_JSON" <<'JSON'
[
  {"kind":"worktree","branch":"agent-x","is_main":false,"is_current":false,
   "path":"/repo/.worktrees/agent-x","main_state":"integrated","commit":{"timestamp":0},
   "working_tree":{"staged":false,"modified":false,"untracked":false,"renamed":false,"deleted":false},
   "remote":null}
]
JSON
    When call run_audit
    The status should be success
    The line 1 of output should equal "$(printf 'agent-x\tintegrated (integrated)')"
  End

  It "audit stays silent when the survivor's PR is still open"
    fixture_merged_survivor
    printf 'OPEN' >"$PR_STATE_FILE"
    When call run_audit
    The status should be success
    The output should equal ""
  End
End
