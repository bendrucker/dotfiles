#!/usr/bin/env zsh

_eval_cache fzf --zsh && source "$REPLY"
_eval_cache op completion zsh && source "$REPLY"
_eval_cache linear completions zsh && source "$REPLY"
