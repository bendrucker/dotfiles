#!/usr/bin/env zsh

export DOTFILES_HOME="$HOME/.dotfiles"

# Resolve which dotfiles root is active. The module lives next to this file;
# ${(%):-%N} resolves through the ~/.zshenv symlink to the active root's copy,
# so it is available before $ZSH is known. dev.zsh reuses the same functions.
source "${${(%):-%N}:A:h}/active-root.zsh"
_dotfiles_resolve_root
export ZSH="$REPLY"

export DOTFILES_TMUX="$ZSH/tmux"

export PROJECTS="$HOME/src"

export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"
export XDG_CACHE_HOME="$HOME/.cache"

export ZDOTDIR="${ZDOTDIR:-$XDG_CONFIG_HOME/zsh}"

for brew in /opt/homebrew/bin/brew /home/linuxbrew/.linuxbrew/bin/brew; do
  if [[ -x "$brew" ]]; then
    eval "$("$brew" shellenv)"
    break
  fi
done

# load the path files
for file in $ZSH/**/path.zsh; do
  source $file
done

# After all path files are loaded (including mise), ensure our bins take priority and deduplicate
typeset -gU path
path=("$ZSH/bin" "$HOME/.local/bin" $path)

[[ -f ~/.zshenv.local ]] && source ~/.zshenv.local
