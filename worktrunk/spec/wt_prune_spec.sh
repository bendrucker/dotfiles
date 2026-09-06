#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016
#
# Locks the wt-prune-audit drift oracle: the rules that decide a worktree a
# healthy prune should already have removed, and the grace period that keeps a
# worktree the pruner has not yet had a chance to touch out of the findings. The
# cases are black-box: PATH-shim stubs for wt and gh feed canned wt list and gh
# pr view state to the real script, following scripts/spec/dotfiles_sync_spec.sh.
#
# The pruner itself is TypeScript, and its own cases live in bin/wt-prune.test.ts.

wtaudit="$SHELLSPEC_PROJECT_ROOT/../bin/wt-prune-audit"

Describe "wt-prune-audit (black-box)"
  setup() {
    sandbox="$SHELLSPEC_TMPBASE/wt-prune"
    repo="$sandbox/repo"
    stubdir="$sandbox/stub"
    export WT_LIST_JSON="$sandbox/list.json"
    export WT_REMOVE_LOG="$sandbox/removed.log"
    export WT_STEP_LOG="$sandbox/step.log"
    export PR_STATE_FILE="$sandbox/pr_state"
    rm -rf "$sandbox"
    mkdir -p "$stubdir"
    : >"$WT_REMOVE_LOG"
    : >"$WT_STEP_LOG"

    # wt stub: `list` feeds the canned survivor set the audit re-derives from,
    # and `config state default-branch get` names the branch wt would refuse to
    # remove, which the audit reads to identify an unprunable worktree. `step`
    # and `remove` are here because the audit must never reach either, and a
    # regression that did would leave a trace in these logs.
    cat >"$stubdir/wt" <<'WT'
#!/usr/bin/env bash
case "$1" in
  step)   printf 'step %s\n' "$*" >>"$WT_STEP_LOG"; echo "[]" ;;
  list)   cat "$WT_LIST_JSON" ;;
  remove) printf 'remove %s\n' "$*" >>"$WT_REMOVE_LOG" ;;
  config) echo main ;;
esac
exit 0
WT
    chmod +x "$stubdir/wt"

    # gh stub: `gh pr view <branch> --json state,number --jq …` resolves to the
    # state under test. pr_state formats it as "STATE\tNUMBER". An empty state
    # file mimics a branch with no PR (real gh exits nonzero, printing nothing).
    cat >"$stubdir/gh" <<'GH'
#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  state="$(cat "$PR_STATE_FILE")"
  [ -n "$state" ] && printf '%s\t42\n' "$state"
fi
exit 0
GH
    chmod +x "$stubdir/gh"

    # A real repo with a github origin, so the host resolution routes pr_state
    # to the gh path. Worktree contents are canned in the fixture.
    git init -q -b main "$repo"
    git -C "$repo" -c user.email=test@example.com -c user.name=test \
      commit -q --allow-empty -m init
    git -C "$repo" remote add origin "https://github.com/test/repo.git"

    # A real linked worktree, so the age helper resolves a per-worktree git dir
    # (a .git *file* pointing at .git/worktrees/<name>) rather than the repo's
    # own .git. Reading the repo's dir instead would date every worktree to the
    # clone, which the fixture must be able to tell apart.
    linked="$sandbox/linked"
    git -C "$repo" worktree add -q -b fresh "$linked" 2>/dev/null

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

  # `zsh -f` skips ~/.zshenv, which after bootstrap re-runs `brew shellenv` and
  # reorders PATH, pushing $stubdir below a real wt/gh and shadowing the stubs.
  run_audit() { ( cd "$repo" && PATH="$stubdir:$PATH" zsh -f "$wtaudit" ); }
  run_audit_grace() {
    ( cd "$repo" && PATH="$stubdir:$PATH" WT_PRUNE_DRIFT_GRACE="$1" zsh -f "$wtaudit" )
  }

  # A merged PR proves the work landed however new the checkout is, so the forge
  # rule reports it without consulting the grace period.
  It "audit flags a merged survivor the prune left behind"
    fixture_merged_survivor
    printf 'MERGED' >"$PR_STATE_FILE"
    When call run_audit
    The status should be success
    The line 1 of output should equal \
      "$(printf 'feature-x\tmerged PR survived\t/repo/.worktrees/feature-x')"
  End

  # This fixture path does not exist, so the age is unresolvable. An unknown age
  # counts as old enough, keeping a missing clock from masking real drift.
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
    The line 1 of output should equal \
      "$(printf 'agent-x\tintegrated (integrated)\t/repo/.worktrees/agent-x')"
  End

  # wt step prune skips a worktree for its first day, because one branched off
  # main reads as integrated before any work lands in it. Without the grace
  # period the audit reports every worktree created since the previous run.
  # $repo is created fresh in setup, so its git dir dates from moments ago.
  It "audit ignores an integrated worktree still inside the grace period"
    : >"$PR_STATE_FILE"
    cat >"$WT_LIST_JSON" <<JSON
[
  {"kind":"worktree","branch":"fresh","is_main":false,"is_current":false,
   "path":"$linked","main_state":"empty","commit":{"timestamp":0},
   "working_tree":{"staged":false,"modified":false,"untracked":false,"renamed":false,"deleted":false},
   "remote":null}
]
JSON
    When call run_audit
    The status should be success
    The output should equal ""
  End

  # Shrinking grace to zero must bring the same worktree back, confirming the
  # skip above came from the age check.
  It "audit flags that same worktree once the grace period is zero"
    cat >"$WT_LIST_JSON" <<JSON
[
  {"kind":"worktree","branch":"fresh","is_main":false,"is_current":false,
   "path":"$linked","main_state":"empty","commit":{"timestamp":0},
   "working_tree":{"staged":false,"modified":false,"untracked":false,"renamed":false,"deleted":false},
   "remote":null}
]
JSON
    When call run_audit_grace 0h
    The status should be success
    The line 1 of output should equal "$(printf 'fresh\tintegrated (empty)\t%s' "$linked")"
  End

  # Grace defers the integration rule only. A merged PR is removed at any age,
  # so a young worktree whose PR merged is still a real miss and the forge check
  # has to run even while the integration rule is inside its grace window.
  It "still reports a merged PR on a worktree inside the grace period"
    printf 'MERGED' >"$PR_STATE_FILE"
    cat >"$WT_LIST_JSON" <<JSON
[
  {"kind":"worktree","branch":"fresh","is_main":false,"is_current":false,
   "path":"$linked","main_state":"integrated","commit":{"timestamp":0},
   "working_tree":{"staged":false,"modified":false,"untracked":false,"renamed":false,"deleted":false},
   "remote":null}
]
JSON
    When call run_audit
    The status should be success
    The line 1 of output should equal \
      "$(printf 'fresh\tmerged PR survived\t%s' "$linked")"
  End

  # A grace spelling parse_duration cannot read must stop the audit rather than
  # silently fall back, which would either bury drift or restore the false
  # positives the grace period exists to remove.
  It "fails loudly on an unparseable grace duration"
    fixture_merged_survivor
    When call run_audit_grace 30min
    The status should equal 1
    The stderr should include "cannot parse"
    The output should equal ""
  End

  # A repo whose main worktree sits on a topic branch leaves the default branch
  # checked out in a linked worktree. `wt step prune` skips that branch, it has
  # no PR, and `wt remove` refuses it, so the age pass used to retry a removal
  # that always fails while the audit filed a to-do for it every night.
  fixture_default_branch_worktree() {
    cat >"$WT_LIST_JSON" <<JSON
[
  {"kind":"worktree","branch":"topic","is_main":true,"is_current":true,
   "path":"/repo","main_state":"is_main","commit":{"timestamp":0},
   "working_tree":{"staged":false,"modified":false,"untracked":false,"renamed":false,"deleted":false},
   "remote":{"ahead":0,"behind":0}},
  {"kind":"worktree","branch":"main","is_main":false,"is_current":false,
   "path":"$linked","main_state":"integrated","commit":{"timestamp":1000},
   "working_tree":{"staged":false,"modified":false,"untracked":false,"renamed":false,"deleted":false},
   "remote":{"ahead":0,"behind":0}}
]
JSON
  }

  It "audit ignores a default-branch worktree at any age"
    fixture_default_branch_worktree
    : >"$PR_STATE_FILE"
    When call run_audit_grace 0h
    The status should be success
    The output should equal ""
  End

  It "audit stays silent when the survivor's PR is still open"
    fixture_merged_survivor
    printf 'OPEN' >"$PR_STATE_FILE"
    When call run_audit
    The status should be success
    The output should equal ""
  End
End
