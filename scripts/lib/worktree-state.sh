# shellcheck shell=bash
# Sourceable worktree facts. bin/worktree-state holds the logic. These functions
# exist so bin/wt-prune-audit keeps the contract it was written against while it
# is still zsh, and they go away with its own conversion.
#
# WT_PRUNE_MIN_AGE
#   The age floor the prune passes apply, resolved by the same code the pruner
#   reads it with so the audit models the guard the pruner actually applied.
#
# parse_duration <spec>
#   Print a duration like 2w / 30d / 1mo in seconds. Nonzero and silent on a
#   spec it does not understand, so a caller can stop rather than guess.
#
# worktree_age_secs <path>
#   Print seconds since the worktree was created, on worktrunk's own clock.
#   Nonzero when the path is gone or no clock reads, which callers treat as old
#   enough.
#
# default_branch
#   Print the branch no prune pass can remove, empty when worktrunk cannot name
#   one.
#
# pr_state <branch> <host>
#   Print the branch's forge state as "STATE\tNUMBER", or nothing when it has
#   no PR or MR.

# Sourced by both zsh and bash callers, so the file's own path comes from
# whichever of the two records it: bash keeps it in BASH_SOURCE, zsh puts it in
# $0 for the duration of the source. Resolved here rather than in the functions,
# because neither name survives into a call.
if [ -n "${BASH_SOURCE:-}" ]; then
  _worktree_state_lib="${BASH_SOURCE[0]}"
else
  _worktree_state_lib="$0"
fi
_worktree_state_bin="$(cd "$(dirname "$_worktree_state_lib")/../../bin" && pwd)/worktree-state"

# Read through the CLI rather than defaulted here, so the pruner and the audit
# cannot drift apart over what an unset or empty override means. Read by the
# caller that sources this, which shellcheck cannot see from here.
# shellcheck disable=SC2034
WT_PRUNE_MIN_AGE="$("$_worktree_state_bin" min-age)"

# Every value travels in the --flag=value form: a value beginning with a dash is
# otherwise taken for the next flag.
parse_duration() {
  "$_worktree_state_bin" duration --spec="$1"
}

worktree_age_secs() {
  "$_worktree_state_bin" age --path="$1"
}

default_branch() {
  "$_worktree_state_bin" default-branch
}

pr_state() {
  "$_worktree_state_bin" pr --branch="$1" --host="$2"
}
