# shellcheck shell=bash
# Sourceable bridge from git_sync's return codes to a failure notification.
# Requires git-sync.sh and report-failure.sh to be sourced first.
#
# git_sync_notify <repo_dir> <title> [branch]
#   Run git_sync and map its result:
#     updated  echo the new short rev, return GIT_SYNC_UPDATED
#     current  return GIT_SYNC_CURRENT
#     failed   notify "<title>" "Failed: could not sync", return GIT_SYNC_FAILED
#   Callers own success messages and post-update side effects. Capture the rev
#   and the code with command substitution. Under `set -e` a bare
#   rev=$(git_sync_notify …); rc=$? aborts before rc=$? runs, because the nonzero
#   "current" (2) result fails the assignment. Seed rc and capture in an AND-OR
#   list so errexit is suppressed: rc=0; rev=$(git_sync_notify …) || rc=$?

git_sync_notify() {
  local repo_dir="$1" title="$2" branch="${3:-}"

  local rev rc=0
  rev=$(git_sync "$repo_dir" "$branch") || rc=$?

  if [[ "$rc" == "$GIT_SYNC_FAILED" ]]; then
    notify "$title" "Failed: could not sync"
  elif [[ "$rc" == "$GIT_SYNC_UPDATED" ]]; then
    echo "$rev"
  fi

  return "$rc"
}
