#!/usr/bin/env zsh

alias sonnet='claude --model sonnet'
alias ccw='wt switch --create --execute=claude'

claude-preset() {
  local preset="$1"; shift
  claude --settings "${HOME}/.config/claude-presets/${preset}.json" "$@"
}
