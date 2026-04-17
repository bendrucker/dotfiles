#!/usr/bin/env zsh

if [[ -n "$TMUX" ]]; then
  if command -v sesh >/dev/null 2>&1; then
    eval "$(sesh completion zsh)"
    compdef _sesh sesh
  fi

  __tmux_fzf_autocomplete() {
    local selected
    selected=$(tmux capture-pane -pS -10000 \
      | awk 'BEGIN { RS = "[ \t\n]" } length($0) > 2 && !seen[$0]++' \
      | fzf --no-sort --exact +i --tac --tmux center,60%,40%)
    LBUFFER="${LBUFFER}${selected}"
    zle redisplay
  }
  zle -N __tmux_fzf_autocomplete
  bindkey '^N' __tmux_fzf_autocomplete
fi
