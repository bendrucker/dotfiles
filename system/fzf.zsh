#!/usr/bin/env zsh
# Catppuccin colors for fzf, flavored to the active macOS appearance.
# Reads from a cache file (no subshell on startup) populated whenever the
# system appearance changes. Falls back to mocha on first install before
# the cache exists.
_fzf_opts_cache="${XDG_CACHE_HOME:-$HOME/.cache}/dotfiles/fzf-default-opts"
# -s (non-empty) guards against a truncated/zero-byte cache from an interrupted
# write; -r alone would let an empty cache blank out FZF_DEFAULT_OPTS entirely.
if [[ -s "$_fzf_opts_cache" ]]; then
  export FZF_DEFAULT_OPTS="$(<"$_fzf_opts_cache")"
else
  export FZF_DEFAULT_OPTS=" \
--color=bg+:#313244,bg:#1e1e2e,spinner:#f5e0dc,hl:#f38ba8 \
--color=fg:#cdd6f4,header:#f38ba8,info:#cba6f7,pointer:#f5e0dc \
--color=marker:#b4befe,fg+:#cdd6f4,prompt:#cba6f7,hl+:#f38ba8 \
--color=selected-bg:#45475a \
--color=border:#6c7086,label:#cdd6f4"
fi
unset _fzf_opts_cache
