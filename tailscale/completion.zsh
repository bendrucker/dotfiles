#!/usr/bin/env zsh

# The macOS app's CLI prints its own startup failures to stdout and still exits
# 0, so an unguarded eval runs the error text as shell code.
_eval_cache --expect '#compdef ' tailscale completion zsh 2>/dev/null && source "$REPLY"
