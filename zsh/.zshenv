#!/usr/bin/env zsh

export DOTFILES_HOME="$HOME/.dotfiles"

# Resolve which dotfiles root is active. The module lives next to this file;
# ${(%):-%N} resolves through the ~/.zshenv symlink to the active root's copy,
# so it is available before $ZSH is known. dev.zsh reuses the same functions.
source "${${(%):-%N}:A:h}/active-root.zsh"
source "${${(%):-%N}:A:h}/eval-cache.zsh"
_dotfiles_resolve_root
export ZSH="$REPLY"


export PROJECTS="$HOME/src"

# Here rather than a topic .zsh file, which only .zshrc sources. A long-lived
# process started outside an interactive shell (a herdr daemon over mosh, a
# launchd job) hands its children no EDITOR otherwise, and they fall back to
# whatever the system ships.
export EDITOR="nvim"

# Turns on Claude Code's debug log in ~/.claude/debug. It has to be in the
# launch environment, because settings.json env is applied after the logger
# reads it. DEBUG would work too but reaches every other tool.
# com.user.claude-debug-env copies this into launchd for apps that exec claude
# without a shell.
export DEBUG_SDK=1

export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"
export XDG_CACHE_HOME="$HOME/.cache"

export ZDOTDIR="${ZDOTDIR:-$XDG_CONFIG_HOME/zsh}"

for brew in /opt/homebrew/bin/brew /home/linuxbrew/.linuxbrew/bin/brew; do
  if [[ -x "$brew" ]]; then
    _eval_cache --depends "${brew:h:h}/Library/Homebrew/cmd/shellenv.sh" "$brew" shellenv && eval "$REPLY"
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

# Deliberately not exported. .zshrc keys its rebuild on this, and a child shell
# that inherited it would read its parent's startup as its own and skip the
# rebuild it needs. See the block at the top of .zshrc.
typeset -g DOTFILES_ZSHENV_RAN=1

[[ -f ~/.zshenv.local ]] && source ~/.zshenv.local

# Not exported, for the same reason. .zshrc restores this order after a login
# shell's /etc/zprofile has run path_helper over it.
typeset -g DOTFILES_ZSHENV_PATH=$PATH
