#!/usr/bin/env zsh

# Create a worktree and start Claude
#
# With a branch name (no spaces): use current repo, explicit branch
#   cc branch-name                    # interactive Claude
#   cc branch-name 'fix the bug'      # Claude with prompt
#
# With a prompt (has spaces): resolve repo + branch via Claude
#   cc 'fix the auth bug in the API'
cc() {
  if [[ $# -lt 1 ]]; then
    echo "Usage: cc <branch> [claude args...]" >&2
    echo "       cc <prompt> [claude args...]" >&2
    return 1
  fi

  local branch repo

  if ! git rev-parse --is-inside-work-tree &>/dev/null || [[ "$1" == *" "* ]]; then
    _cc_resolve "$@"
    return
  fi

  branch="$1"
  shift
  wt switch --create "$branch" && claude "$@"
}

_cc_resolve() {
  local prompt="$1"
  shift

  local repo_list
  repo_list=$(find "$PROJECTS" -maxdepth 3 -name .git -type d -exec dirname {} \; 2>/dev/null | sort)

  local result
  result=$(claude -p --model haiku --no-session-persistence --output-format json \
    --tools "" --strict-mcp-config --disable-slash-commands \
    --json-schema '{"type":"object","properties":{"repo":{"type":"string"},"branch":{"type":"string"}},"required":["repo","branch"]}' \
    "Given a task and a list of repositories, respond with:
- repo: the absolute path of the repository this task should be done in
- branch: a short, descriptive git branch name (lowercase, hyphens, no prefixes)

Task: $prompt

Repositories:
$repo_list")

  local repo branch
  repo=$(echo "$result" | jq -r '.structured_output.repo')
  branch=$(echo "$result" | jq -r '.structured_output.branch')

  if [[ -z "$repo" || ! -d "$repo" ]]; then
    echo "Could not determine repository for: $prompt" >&2
    return 1
  fi

  if [[ -z "$branch" ]]; then
    echo "Could not generate branch name for: $prompt" >&2
    return 1
  fi

  echo "→ $repo @ $branch"
  cd "$repo" && wt switch --create "$branch" && claude "$prompt" "$@"
}
