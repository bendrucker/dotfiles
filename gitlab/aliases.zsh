#!/usr/bin/env zsh

# Ordered by measured usage. `mr` rather than `gl` to avoid reading as a
# variant of `gl` (git log); these operate on merge requests, not glab at large.
alias mrc='glab mr checkout'
alias mrl='glab mr list'
alias mrv='glab mr view'
alias mrd='glab mr diff'
