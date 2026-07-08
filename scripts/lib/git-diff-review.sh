# shellcheck shell=bash
# Sourceable interactive handler for a dirty working tree before a sync.
# Requires report-failure.sh (notify) and git-sync.sh (git_default_branch) to be
# sourced first. gum and gh must be on PATH.
#
# render_diff [repo_dir]
#   Print the diff of tracked changes against HEAD. JSON files are normalized
#   with `jq -S` so cosmetic key reordering doesn't show as noise; everything
#   else falls back to plain `git diff HEAD`.
#
# git_review_open_pr <repo_dir> <title>
#   Capture the working-tree changes (tracked and untracked) onto a fresh branch,
#   push it, and open a draft PR with `gh`, then return the base branch to a clean
#   state so the caller can fast-forward it. Returns nonzero if any step fails,
#   leaving the base branch checked out.
#
# git_review_dirty <repo_dir> <title>
#   If the tree is clean, return 0. Otherwise render the diff and, on a TTY,
#   prompt to discard, open a PR, or skip. Without a TTY (launchd) it skips.
#   Returns 0 when the tree is clean to continue syncing (discard or PR), 1 to
#   abort the sync (skip).

render_diff() {
  local repo_dir="${1:-.}"
  (
    cd "$repo_dir" || return
    local changed_files
    changed_files=$(git diff HEAD --name-only 2>/dev/null)
    [[ -z "$changed_files" ]] && return

    local f head_sorted working_sorted
    while IFS= read -r f; do
      [[ -f "$f" ]] || continue
      if [[ "$f" == *.json ]]; then
        head_sorted=$(git show "HEAD:$f" 2>/dev/null | jq -S . 2>/dev/null) &&
          working_sorted=$(jq -S . "$f" 2>/dev/null) &&
          { diff -u --label "a/$f" --label "b/$f" <(echo "$head_sorted") <(echo "$working_sorted") || true; continue; }
      fi
      git diff HEAD -- "$f" 2>/dev/null
    done <<< "$changed_files"
  )
}

git_review_open_pr() {
  local repo_dir="$1" title="$2"

  local base branch host
  base=$(git -C "$repo_dir" symbolic-ref --short HEAD 2>/dev/null || git_default_branch "$repo_dir")
  host=$(hostname -s)
  branch="sync/local-changes-$(date +%Y%m%d-%H%M%S)"

  gum log --level info "Opening a PR for local changes on $branch..."

  if ! git -C "$repo_dir" checkout -b "$branch"; then
    gum log --level error "Failed to create $branch"
    return 1
  fi

  if ! git -C "$repo_dir" add -A ||
     ! git -C "$repo_dir" commit -m "sync: local changes captured on $host"; then
    gum log --level error "Failed to commit local changes"
    git -C "$repo_dir" checkout "$base"
    return 1
  fi

  if ! gum spin --show-error --title "Pushing $branch" -- \
    git -C "$repo_dir" push -u origin "$branch"; then
    gum log --level error "Failed to push $branch - change is committed locally on $branch"
    git -C "$repo_dir" checkout "$base"
    return 1
  fi

  local pr_url
  if ! pr_url=$(cd "$repo_dir" && gh pr create --draft --base "$base" --head "$branch" --fill 2>&1); then
    gum log --level error "Failed to create PR: $pr_url"
    git -C "$repo_dir" checkout "$base"
    return 1
  fi

  git -C "$repo_dir" checkout "$base"
  gum log --level info "PR opened: $pr_url"
  notify "$title" "Opened PR for local changes"
}

git_review_dirty() {
  local repo_dir="$1" title="$2"

  local tree
  tree=$(git -C "$repo_dir" status --porcelain 2>/dev/null)
  if [[ -z "$tree" ]]; then
    return 0
  fi

  gum log --level info "Local changes in $repo_dir:"
  echo "$tree"
  gum log --level info "Diff:"
  render_diff "$repo_dir"

  if [[ ! -t 0 ]]; then
    gum log --level error "Local changes present - skipping sync"
    notify "$title" "Skipped: local changes present"
    return 1
  fi

  local choice
  choice=$(gum choose --header "Local changes present. What now?" \
    "Discard and sync" "Open a PR and sync" "Skip sync") || choice="Skip sync"

  case "$choice" in
    "Discard and sync")
      gum log --level info "Discarding local changes..."
      git -C "$repo_dir" reset --hard HEAD
      git -C "$repo_dir" clean -fd
      ;;
    "Open a PR and sync")
      git_review_open_pr "$repo_dir" "$title" || return 1
      ;;
    *)
      gum log --level error "Local changes present - skipping sync"
      notify "$title" "Skipped: local changes present"
      return 1
      ;;
  esac
}
