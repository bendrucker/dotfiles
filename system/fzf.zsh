#!/usr/bin/env zsh
# Catppuccin colors for fzf, flavored to the active macOS appearance.
# fzf reads this file fresh on every launch, so the theme-sync watcher only has
# to rewrite its contents (no per-shell export, no subshell at startup). The
# file is seeded by the theme reconcile at install time.
export FZF_DEFAULT_OPTS_FILE="${XDG_CACHE_HOME:-$HOME/.cache}/dotfiles/fzf-default-opts"
