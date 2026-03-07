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

  local session
  session=$(tmux display-message -p '#S')
  echo detach-client | TMUX= tmux -C attach-session -t "=$session" -c "$dir" >/dev/null 2>&1
  echo "tmux working directory → $dir"
}
