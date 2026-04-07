#!/usr/bin/env zsh

alias wts='wt switch'

wtp () {
  wt step prune "$@"

  local branches
  branches=$(wt list --format=json | jq -r '.[] | select(.is_main | not) | .branch')
  [[ -z "$branches" ]] && return

  local remote_host
  remote_host=$(git remote get-url origin 2>/dev/null | sed -E 's|^[^@]*@||; s|^https?://||; s|[:/].*||')

  local -a merged_branches
  if [[ "$remote_host" == *gitlab* ]]; then
    merged_branches=("${(@f)$(glab mr list --state merged --output json 2>/dev/null | jq -r '.[].source_branch')}")
  else
    merged_branches=("${(@f)$(gh pr list --state merged --json headRefName --jq '.[].headRefName' 2>/dev/null)}")
  fi

  local branch
  for branch in ${(f)branches}; do
    if (( ${merged_branches[(Ie)$branch]} )); then
      echo "Removing $branch (PR merged)"
      wt remove --force --force-delete "$branch"
    fi
  done
}
