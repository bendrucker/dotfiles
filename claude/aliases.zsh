#!/usr/bin/env zsh

# Source SSH detection function
source "$ZSH/ssh/functions.zsh"

# Conditionally wrap claude with SSH-specific wrapper for SSH/Mosh sessions
if is_remote_session; then
  alias claude='$ZSH/claude/ssh-wrapper'
fi

alias sonnet='claude --model sonnet'
