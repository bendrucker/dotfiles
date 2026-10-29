#!/usr/bin/env zsh

# Complete the worktree launchers as the `wt switch` they wrap.
_claude_cw() {
  words=(wt switch "${words[@]:1}")
  (( CURRENT++ ))
  _clap_dynamic_completer_wt "$@"
}

_claude_cwp() {
  words=(wt switch --create "${words[@]:1}")
  (( CURRENT += 2 ))
  _clap_dynamic_completer_wt "$@"
}

compdef _claude_cw cw
compdef _claude_cwp cwp
