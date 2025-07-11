#!/usr/bin/env zsh

# Source SSH detection function
source "$ZSH/ssh/functions.zsh"

# Conditionally wrap claude with keychain unlock for SSH/Mosh sessions
if is_remote_session; then
  alias claude='with-ssh-keychain claude'
fi

alias sonnet='claude --model sonnet'
