#!/usr/bin/env zsh
# Catppuccin Mocha colors for fzf. Pinned: fzf reads FZF_DEFAULT_OPTS at
# invocation, so an in-shell flip would still leave running shells stale.
export FZF_DEFAULT_OPTS=" \
--color=bg+:#313244,bg:#1e1e2e,spinner:#f5e0dc,hl:#f38ba8 \
--color=fg:#cdd6f4,header:#f38ba8,info:#cba6f7,pointer:#f5e0dc \
--color=marker:#b4befe,fg+:#cdd6f4,prompt:#cba6f7,hl+:#f38ba8 \
--color=selected-bg:#45475a \
--color=border:#6c7086,label:#cdd6f4"
