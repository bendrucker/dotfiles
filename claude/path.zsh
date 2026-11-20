#!/usr/bin/env zsh

# Every Bash call fails if the prefix can't run, so set it only where it can.
if (( $+commands[taskpolicy] )); then
  export CLAUDE_CODE_SHELL_PREFIX="$ZSH/claude/shell-prefix"
fi

# Claude Code 2.1.329 trusts a kitty graphics reply only from kitty or ghostty,
# so `<Image>` panes stay blank in Rex. Delete this once Claude Code accepts
# `rex` in its kitty-graphics terminal allowlist.
if [[ $TERM_PROGRAM == rex ]]; then
  export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1
fi
