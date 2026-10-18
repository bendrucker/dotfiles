#!/usr/bin/env zsh

# Every Bash call fails if the prefix can't run, so set it only where it can.
if (( $+commands[taskpolicy] )); then
  export CLAUDE_CODE_SHELL_PREFIX="$ZSH/claude/shell-prefix"
fi
