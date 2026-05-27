#!/usr/bin/env zsh

alias cw='wt switch --execute="claude --name={{ branch }}"'
alias ccw='cw --create'

cwp() {
  wt switch --create --execute="claude --name={{ branch }} --permission-mode=plan" "$@" -- "$(pbpaste)"
}

alias cwa='wt switch --execute="claude --name={{ branch }} --permission-mode=auto"'
