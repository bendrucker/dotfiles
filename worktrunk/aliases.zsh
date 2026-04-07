#!/usr/bin/env zsh

alias wts='wt switch'

wtp () {
  wt step prune "$@"

  local branch
  while IFS= read -r branch; do
    local pr_state
    pr_state=$(gh pr view "$branch" --json state --jq '.state' 2>/dev/null) || continue
    if [[ "$pr_state" == "MERGED" ]]; then
      echo "Removing $branch (PR merged)"
      wt remove --force --force-delete "$branch"
    fi
  done < <(wt list --format=json | jq -r '.[] | select(.is_main | not) | .branch')
}
