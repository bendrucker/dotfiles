#!/usr/bin/env zsh

if command -v herdr > /dev/null; then
  eval "$(herdr completion zsh)"
fi

# Complete a word from what this pane has already printed: a path, a branch, a
# container id, anything on screen that would be retyped otherwise. Came from the
# tmux config, where the capture was `tmux capture-pane` and fzf drew itself in a
# tmux popup.
#
# `recent-unwrapped` rejoins soft-wrapped lines, so a long path that the pane
# broke across rows comes back as one word instead of two halves.
if [[ -n "$HERDR_PANE_ID" ]]; then
  __herdr_fzf_autocomplete() {
    local selected
    selected=$(herdr pane read "$HERDR_PANE_ID" --source recent-unwrapped --lines 10000 2>/dev/null \
      | awk 'BEGIN { RS = "[ \t\n]" } length($0) > 2 && !seen[$0]++' \
      | fzf --no-sort --exact +i --tac --height 40%)
    LBUFFER="${LBUFFER}${selected}"
    zle redisplay
  }
  zle -N __herdr_fzf_autocomplete
  bindkey '^N' __herdr_fzf_autocomplete
fi
