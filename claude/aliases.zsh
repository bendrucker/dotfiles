#!/usr/bin/env zsh

# Injected into Claude sessions launched in a Worktrunk worktree so the agent
# knows it has a dedicated branch to work on. Avoid apostrophes: the value is
# single-quoted inside the --execute string that wt tokenizes.
_claude_worktree_prompt='This is a dedicated git worktree that Worktrunk (the wt CLI) created for you. Do your work here directly: make changes, commit, and open a PR from this branch.'

# Aliases (not functions) so zsh defers completion to `wt switch` for branch names.
alias cw="wt switch --execute=\"claude --name={{ branch }} --append-system-prompt='$_claude_worktree_prompt'\""
alias ccw='cw --create'
alias cwa='cw'

cwp() {
  wt switch --create --execute="claude --name={{ branch }} --permission-mode=plan --append-system-prompt='$_claude_worktree_prompt'" "$@" -- "$(pbpaste)"
}

# Open the background-agent view (`claude agents`). Launch new agents with the
# claude-launch command; logs, stop, and attach live inside the view.
alias ca='claude agents'
