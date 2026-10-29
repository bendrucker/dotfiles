#!/usr/bin/env zsh

# Injected into Claude sessions launched in a Worktrunk worktree so the agent
# knows it has a dedicated branch to work on.
_claude_worktree_prompt="This is a dedicated git worktree that Worktrunk (the wt CLI) created for you. Do your work here directly: make changes, commit, and open a PR from this branch."

# Arguments before `--` go to `wt switch`, the rest to `claude`. Claude runs
# under the shell after wt's shell integration has moved it into the worktree.
cw() {
  local split=${@[(i)--]}
  wt switch "${@[1,split-1]}" || return
  claude --name="$(git branch --show-current)" --append-system-prompt="$_claude_worktree_prompt" "${@[split+1,-1]}"
}
alias ccw='cw --create'

cwp() {
  cw --create "$@" -- --permission-mode=plan "$(pbpaste)"
}

# Open the background-agent view (`claude agents`). Launch new agents with the
# claude-launch command; logs, stop, and attach live inside the view.
alias ca='claude agents'
