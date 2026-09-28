#!/usr/bin/env zsh

_eval_cache fzf --zsh && eval "$REPLY"
_eval_cache op completion zsh && eval "$REPLY"
_eval_cache linear completions zsh && eval "$REPLY"
