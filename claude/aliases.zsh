#!/usr/bin/env zsh

# Injected into Claude sessions launched in a Worktrunk worktree so the agent
# knows it has a dedicated branch to work on.
_claude_worktree_prompt='This is a dedicated git worktree that Worktrunk (the wt CLI) created for you. Do your work here directly: make changes, commit, and open a PR from this branch.'

# Runs `wt switch -x claude`. Arguments before the first `--` are wt options,
# and arguments after it are appended to claude's.
_claude_worktree_switch() {
  local mode=$1
  shift
  local split=${argv[(i)--]}
  local -a claude=(--name='{{ branch }}' --append-system-prompt="$_claude_worktree_prompt")
  [[ -n $mode ]] && claude+=(--permission-mode="$mode")
  wt switch "${(@)argv[1,split-1]}" -x claude -- "${claude[@]}" "${(@)argv[split+1,-1]}"
}

cw() { _claude_worktree_switch '' "$@" }
ccw() { _claude_worktree_switch '' --create "$@" }
cwa() { _claude_worktree_switch auto "$@" }
cwp() { _claude_worktree_switch plan --create "$@" -- "$(pbpaste)" }

# Open the background-agent view (`claude agents`). Launch new agents with the
# claude-launch command; logs, stop, and attach live inside the view.
alias ca='claude agents'
