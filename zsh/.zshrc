#!/usr/bin/env zsh

if [[ -n "$ZPROF" ]]; then
  zmodload zsh/zprof
fi

# A shell that found no .zshenv has no PATH of its own, only whatever it
# inherited. zsh reads its per-user .zshenv from $ZDOTDIR and falls back to
# ~/.zshenv only when ZDOTDIR is unset. .zshenv exports ZDOTDIR and
# zsh/symlinks.conf installs only .zshrc there, so every zsh below the first one
# skips .zshenv entirely and keeps whatever PATH its parent froze. A pane under
# a server that started before a topic existed never sees that topic's bin, no
# matter how many times the shell restarts.
#
# Installing a second .zshenv under $ZDOTDIR would fix that too, by making every
# `#!/usr/bin/env zsh` script pay for the loop: ~110ms against the ~6ms a nested
# zsh costs now, most of it forks for `brew shellenv` and `mise activate`.
# Rebuilding here keeps that cost on interactive shells, and the scripts one
# launches inherit the rebuilt PATH anyway.
#
# Ahead of the local files, so a topic's path.zsh loses to them the same way it
# does when .zshenv ran. ${(%):-%N} resolves through the $ZDOTDIR/.zshrc symlink,
# picking up the .zshenv beside whichever root this .zshrc came from.
if [[ -z "$DOTFILES_ZSHENV_RAN" ]]; then
  source "${${(%):-%N}:A:h}/.zshenv"
fi

for localrc in ~/.localrc ~/.zshrc.local; do
  [[ -f $localrc ]] && source $localrc
done

# all of our zsh files
typeset -U config_files
config_files=($ZSH/**/*.zsh)

FPATH="$HOMEBREW_PREFIX/share/zsh/site-functions:${FPATH}"

# load everything but the path and completion files
for file in ${${config_files:#*/path.zsh}:#*/completion.zsh}
do
  source $file
done

# initialize autocomplete
autoload -Uz compinit bashcompinit
compinit -C
bashcompinit

unset config_files

# defer all completions until after first prompt
autoload -Uz add-zsh-hook
_load_deferred_completions() {
  add-zsh-hook -d precmd _load_deferred_completions
  for file in $ZSH/**/completion.zsh; do
    source $file
  done
}
add-zsh-hook precmd _load_deferred_completions

if [[ -n "$ZPROF" ]]; then
  zprof
fi
