#!/usr/bin/env zsh

alias wts='wt switch'

wtp () {
  wt step prune "$@"

  local remote_url
  remote_url=$(git remote get-url origin 2>/dev/null)

  local branch
  while IFS= read -r branch; do
    local state
    if [[ "$remote_url" == *gitlab* ]]; then
      state=$(glab mr view "$branch" --output json 2>/dev/null | jq -r '.state') || continue
      [[ "$state" == "merged" ]] || continue
    else
      state=$(gh pr view "$branch" --json state --jq '.state' 2>/dev/null) || continue
      [[ "$state" == "MERGED" ]] || continue
    fi
    echo "Removing $branch (PR merged)"
    wt remove --force --force-delete "$branch"
  done < <(wt list --format=json | jq -r '.[] | select(.is_main | not) | .branch')
}
