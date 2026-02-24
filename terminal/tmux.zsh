#!/usr/bin/env zsh

[[ -n "$TMUX" ]] || return 0

twd() {
  local dir="${1:-$PWD}"

  dir="${dir:a}"

  if [[ ! -e "$dir" ]]; then
    echo "twd: no such directory: $dir" >&2
    return 1
  fi

  if [[ ! -d "$dir" ]]; then
    echo "twd: not a directory: $dir" >&2
    return 1
  fi

  tmux attach-session -t . -c "$dir"
  echo "tmux working directory → $dir"
}
