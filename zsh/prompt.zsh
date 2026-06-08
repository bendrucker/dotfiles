#!/usr/bin/env zsh

# Pure prompt, recolored to the active catppuccin flavor.
#
# Pure re-reads its `zstyle :prompt:pure:*` colors on every render (via
# prompt_pure_set_colors in its precmd), so to follow the light/dark switch we
# only need a precmd hook that rewrites those zstyles when the flavor flips. The
# flavor is published to a cache file by theme/bin/theme-sync-pure (driven by the
# dark-notify watcher), exactly like the fzf opts cache — the hot path is a
# builtin read + compare, no fork and no signal.

typeset -g _pure_flavor_cache="${XDG_CACHE_HOME:-$HOME/.cache}/dotfiles/theme-flavor"
typeset -g _pure_flavor_applied=''

# Map the catppuccin palette onto pure's color elements for a given flavor. Hex
# values render as %F{#rrggbb} truecolor (tmux/core sets terminal-features RGB).
# Only the visible elements are set; everything else keeps pure's default.
_pure_apply_flavor() {
  local flavor=$1
  local path_c success_c error_c branch_c dirty_c arrow_c action_c exec_c dim_c root_c jobs_c node_c
  case $flavor in
    latte)  # light
      path_c='#1e66f5'; success_c='#8839ef'; error_c='#d20f39'
      branch_c='#7c7f93'; dirty_c='#df8e1d'; arrow_c='#179299'
      action_c='#e64553'; exec_c='#df8e1d'; dim_c='#8c8fa1'
      root_c='#d20f39'; jobs_c='#fe640b'; node_c='#40a02b'
      ;;
    *)      # mocha (dark) — also the no-cache fallback
      path_c='#89b4fa'; success_c='#cba6f7'; error_c='#f38ba8'
      branch_c='#9399b2'; dirty_c='#f9e2af'; arrow_c='#94e2d5'
      action_c='#eba0ac'; exec_c='#f9e2af'; dim_c='#7f849c'
      root_c='#f38ba8'; jobs_c='#fab387'; node_c='#a6e3a1'
      ;;
  esac

  zstyle :prompt:pure:path                color $path_c
  zstyle :prompt:pure:prompt:success      color $success_c
  zstyle :prompt:pure:prompt:error        color $error_c
  zstyle :prompt:pure:prompt:continuation color $dim_c
  zstyle :prompt:pure:git:branch          color $branch_c
  zstyle :prompt:pure:git:branch:cached   color $error_c
  zstyle :prompt:pure:git:dirty           color $dirty_c
  zstyle :prompt:pure:git:arrow           color $arrow_c
  zstyle :prompt:pure:git:stash           color $arrow_c
  zstyle :prompt:pure:git:action          color $action_c
  zstyle :prompt:pure:execution_time      color $exec_c
  zstyle :prompt:pure:host                color $dim_c
  zstyle :prompt:pure:user                color $dim_c
  zstyle :prompt:pure:user:root           color $root_c
  zstyle :prompt:pure:virtualenv          color $dim_c
  zstyle :prompt:pure:suspended_jobs      color $jobs_c
  zstyle :prompt:pure:node_version        color $node_c

  _pure_flavor_applied=$flavor
}

# Re-sync colors when the cached flavor changes. Builtin read, no fork; the
# zstyle rewrite only runs on an actual flip. Pure's own precmd re-reads these
# zstyles right after, so the new palette lands without re-initializing pure.
_pure_flavor_precmd() {
  local flavor
  read -r flavor < $_pure_flavor_cache 2>/dev/null || return
  [[ $flavor == $_pure_flavor_applied ]] && return
  _pure_apply_flavor $flavor
}

# Seed colors before the first prompt. Fall back to mocha (matching the tmux
# @catppuccin_flavor default) without forking if no theme-sync has run yet.
() {
  local seed
  read -r seed < $_pure_flavor_cache 2>/dev/null || seed=mocha
  _pure_apply_flavor $seed
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd _pure_flavor_precmd

autoload -U promptinit
promptinit
prompt pure
