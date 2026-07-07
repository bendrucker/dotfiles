#!/usr/bin/env zsh

# Page gh output through delta so `gh pr diff` gets the same formatting as
# `git diff`. delta passes non-diff content through unchanged.
export GH_PAGER=delta
