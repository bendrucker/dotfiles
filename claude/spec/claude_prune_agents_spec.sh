#!/usr/bin/env bash
# shellcheck disable=SC2329,SC2016,SC2086
#
# Locks the claude-prune-agents removal invariant against a silent regression:
# an agent is removable only when every PR it produced has left the open state.
# classify_agent (the source of truth) is exercised by sourcing
# bin/claude-prune-agents under the ZSH_EVAL_CONTEXT guard, which defines the
# functions without running the prune. The dry-run case is black-box: PATH-shim
# stubs for claude/gh/gum feed canned agent JSON and PR states to the real
# script, following scripts/spec/dotfiles_sync_spec.sh.

prune="$SHELLSPEC_PROJECT_ROOT/../bin/claude-prune-agents"

run_classify() { zsh -fc 'source "$1"; shift; classify_agent "$@"' _ "$prune" "$@"; }

Describe "classify_agent decision matrix"
  # PR states (space separated) -> action reason. NOPR is the sentinel for an
  # agent with no discoverable PR, which reaches classify_agent as zero args.
  Parameters
    "NOPR"             "skip"   "no PRs"
    "OPEN"             "keep"   "open PR"
    # One open PR outranks any number of terminal ones: work is still in flight.
    "MERGED OPEN"      "keep"   "open PR"
    "MERGED"           "stale"  "merged"
    "MERGED MERGED"    "stale"  "merged"
    # Closed-unmerged does not block, so a terminal mix is still removable.
    "MERGED CLOSED"    "stale"  "merged, closed"
    "CLOSED"           "stale"  "closed"
    # A failed lookup blocks removal: the PR behind it may well be open, so it
    # must not be classified away by whatever else did resolve.
    "ERROR"            "keep"   "PR lookup failed"
    "MERGED ERROR"     "keep"   "PR lookup failed"
    "OPEN ERROR"       "keep"   "open PR"
    # An unmodeled state can never delete an agent.
    "DRAFTED"          "keep"   "unknown PR state"
  End

  Example "[$1] -> $2 ($3)"
    states="$1"; [ "$states" = NOPR ] && states=""
    When call run_classify $states
    The output should equal "$(printf '%s\t%s' "$2" "$3")"
    The status should be success
  End
End

Describe "split_worktree_path"
  run_split() { zsh -fc 'source "$1"; shift; split_worktree_path "$@"' _ "$prune" "$@"; }

  Parameters
    "/src/repo/.worktrees/feature-x"          "/src/repo"  "feature-x"
    "/src/repo/.claude/worktrees/feature-x"   "/src/repo"  "feature-x"
  End

  Example "$1 splits into $2 and $3"
    When call run_split "$1"
    The output should equal "$(printf '%s\t%s' "$2" "$3")"
  End

  It "fails on a path that is not a worktree"
    When call run_split "/src/repo"
    The status should be failure
    The output should equal ""
  End
End

Describe "claude-prune-agents --dry-run (black-box)"
  setup() {
    sandbox="$SHELLSPEC_TMPBASE/claude-prune-agents"
    stubdir="$sandbox/stub"
    repo="$sandbox/repo"
    export CLAUDE_RM_LOG="$sandbox/removed.log"
    rm -rf "$sandbox"
    mkdir -p "$stubdir" "$repo/.worktrees"
    : >"$CLAUDE_RM_LOG"

    # The script reads each agent's summary from $HOME/.claude/jobs/<id>/state.json.
    export HOME="$sandbox"

    # merged-agent worked in a worktree, so its branch resolves a merged PR.
    # open-agent's branch resolves an open PR. bare-agent has no worktree and a
    # summary whose bare #77 ref resolves against its cwd repo. lost-agent has
    # neither a worktree nor a resolvable repo, so it has no discoverable PR.
    write_state() {
      mkdir -p "$sandbox/.claude/jobs/$1"
      printf '{"worktreePath":"%s","detail":"%s","output":{"result":""}}\n' \
        "$2" "$3" >"$sandbox/.claude/jobs/$1/state.json"
    }
    write_state merged01 "$repo/.worktrees/merged-branch" "shipped it"
    write_state open0001 "$repo/.worktrees/open-branch"   "shipped it"
    write_state bare0001 ""                               "shipped as PR #77"
    write_state lost0001 ""                               "nothing to see"
    # flaky-agent's branch query fails while its summary ref still resolves to a
    # merged PR: classifying from that partial result would remove it.
    write_state flaky001 "$repo/.worktrees/flaky-branch"  "shipped as PR #77"

    cat >"$sandbox/agents.json" <<JSON
[
  {"id":"merged01","cwd":"$repo","kind":"background","startedAt":1,"name":"merged agent","state":"done"},
  {"id":"open0001","cwd":"$repo","kind":"background","startedAt":1,"name":"open agent","state":"done"},
  {"id":"bare0001","cwd":"$repo","kind":"background","startedAt":1,"name":"bare ref agent","state":"done"},
  {"id":"lost0001","cwd":"$sandbox/gone","kind":"background","startedAt":1,"name":"lost agent","state":"done"},
  {"id":"flaky001","cwd":"$repo","kind":"background","startedAt":1,"name":"flaky agent","state":"done"},
  {"id":"working1","cwd":"$repo","kind":"background","startedAt":1,"name":"busy agent","state":"working"},
  {"pid":123,"cwd":"$repo","kind":"interactive","startedAt":1,"name":"live session","status":"idle"}
]
JSON

    # claude stub: `agents --json --all` emits the fixture; `rm` only logs, so a
    # dry-run that wrongly removed would leave a trace here.
    cat >"$stubdir/claude" <<'CLAUDE'
#!/usr/bin/env bash
case "$1" in
  agents) cat "$AGENTS_JSON" ;;
  rm)     printf 'rm %s\n' "$2" >>"$CLAUDE_RM_LOG" ;;
esac
exit 0
CLAUDE
    chmod +x "$stubdir/claude"
    export AGENTS_JSON="$sandbox/agents.json"

    # gh stub: repo view names the repo, pr list resolves a branch, pr view
    # resolves a bare ref. Unknown branches and numbers print nothing, matching
    # real gh's empty/nonzero result for a branch or ref with no PR.
    cat >"$stubdir/gh" <<'GH'
#!/usr/bin/env bash
case "$2" in
  view)
    case "$1" in
      repo) echo "test/repo" ;;
      pr)   [ "$3" = "77" ] && echo "MERGED" ;;
    esac
    ;;
  list)
    case "$*" in
      *merged-branch*) printf '1\tMERGED\n' ;;
      *open-branch*)   printf '2\tOPEN\n' ;;
      # A transient failure: empty output, but nonzero, as real gh exits on an
      # auth, rate-limit, or network error.
      *flaky-branch*)  exit 1 ;;
    esac
    ;;
esac
exit 0
GH
    chmod +x "$stubdir/gh"

    # gum stub: unused on the non-interactive dry-run path, present so an
    # accidental call cannot escape to the real binary.
    printf '#!/usr/bin/env bash\nexit 0\n' >"$stubdir/gum"
    chmod +x "$stubdir/gum"

    # A PATH holding only what the script needs, so the no-gum case can drop gum
    # without a real one further down $PATH shadowing its absence.
    nogum="$sandbox/nogum"
    mkdir -p "$nogum"
    for tool in zsh bash cat jq grep cut column mktemp; do
      ln -sf "$(command -v "$tool")" "$nogum/$tool"
    done
    ln -sf "$stubdir/claude" "$nogum/claude"
    ln -sf "$stubdir/gh" "$nogum/gh"
  }
  BeforeEach 'setup'

  # `zsh -f` skips ~/.zshenv, which after bootstrap re-runs `brew shellenv` and
  # reorders PATH, pushing $stubdir below a real claude/gh and shadowing the stubs.
  run_prune() { PATH="$stubdir:$PATH" zsh -f "$prune" "$@"; }
  run_prune_nogum() { PATH="$nogum" zsh -f "$prune" "$@"; }

  It "classifies each completed agent and removes nothing"
    When call run_prune --dry-run
    The status should be success
    The output should include "DECISION"
    The output should include "merged01"
    The output should include "#1 merged"
    The output should include "stale"
    The output should include "open0001"
    The output should include "#2 open"
    The output should include "keep"
    The output should include "no PRs"
    The output should include "2 agents removable (2 kept, 1 skipped: no PRs)"
    The contents of file "$CLAUDE_RM_LOG" should equal ""
  End

  # A failed branch query is empty output, same as a branch with no PR. Reading
  # it as "no PRs" would let the agent's merged summary ref carry it to stale.
  It "keeps an agent whose branch query failed"
    When call run_prune --dry-run
    The status should be success
    The output should include "lookup failed"
    The output should not include "flaky001  flaky agent  stale"
  End

  It "resolves a bare PR ref against the agent's own repo"
    When call run_prune --dry-run
    The status should be success
    The output should include "#77 merged"
  End

  It "leaves agents that are not done alone"
    When call run_prune --dry-run
    The status should be success
    The output should not include "working1"
    The output should not include "live session"
  End

  It "removes every stale agent under --force"
    When call run_prune --force
    The status should be success
    The output should include "2 agents removed"
    The contents of file "$CLAUDE_RM_LOG" should include "rm merged01"
    The contents of file "$CLAUDE_RM_LOG" should include "rm bare0001"
    The contents of file "$CLAUDE_RM_LOG" should not include "rm open0001"
    The contents of file "$CLAUDE_RM_LOG" should not include "rm lost0001"
    The contents of file "$CLAUDE_RM_LOG" should not include "rm flaky001"
  End

  # Without gum there is no checklist to approve the batch, so removing nothing
  # while reporting success would read as "nothing was stale".
  It "fails loudly when interactive selection has no gum"
    When call run_prune_nogum
    The status should equal 1
    The stderr should include "gum is required"
    The contents of file "$CLAUDE_RM_LOG" should equal ""
  End

  It "rejects an unknown option"
    When call run_prune --nope
    The status should equal 1
    The stderr should include "unknown option"
    The contents of file "$CLAUDE_RM_LOG" should equal ""
  End
End
