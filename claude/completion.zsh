#!/usr/bin/env zsh

# Complete the worktree launchers as `wt switch`.
_claude_worktree_switch_complete() {
  words=(wt switch "${(@)words[2,-1]}")
  (( CURRENT++ ))
  _clap_dynamic_completer_wt
}
compdef _claude_worktree_switch_complete cw ccw cwa cwp
