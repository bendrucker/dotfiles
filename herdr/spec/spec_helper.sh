#!/usr/bin/env bash
# shellcheck shell=bash
# Shared fixtures for the herdr launcher specs.

# launcher_on_path <name>
#   Resolve <name> the way a login shell does and check it lands on this
#   worktree's copy. path.zsh is one of the two files .zshrc skips, so sourcing
#   it under a chosen $ZSH is what the shell does to it. -f keeps the installed
#   root out, which is what makes this test the branch rather than ~/.dotfiles.
launcher_on_path() {
  local name="$1" root resolved expected
  root=$(cd "$SHELLSPEC_PROJECT_ROOT/.." && pwd)
  expected="$SHELLSPEC_PROJECT_ROOT/bin/$name"
  # shellcheck disable=SC2016 # $ZSH and $1 belong to the zsh being spawned
  resolved=$(zsh -fc 'ZSH=$1; source "$ZSH/herdr/path.zsh"; command -v '"$name" _ "$root") || return
  if [[ ! "$resolved" -ef "$expected" ]]; then
    echo "resolved $resolved, expected $expected"
    return 1
  fi
}

# Guard for `Skip if`, so a machine without shellcheck reports a skip rather
# than a failure.
shellcheck_missing() {
  ! command -v shellcheck >/dev/null 2>&1
}
