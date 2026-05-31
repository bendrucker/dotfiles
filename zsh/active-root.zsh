# shellcheck shell=bash
# Owns "which dotfiles root is active, and how to switch to one".
#
# Sourced two ways:
#   - early from .zshenv, before $ZSH is known, to route shell startup
#   - again via the zshrc topic loop, so dev.zsh can reuse switch/resolve
#
# Must stay fork-free: .zshenv runs on every shell and startup is CI-gated.
# $(<file) is a builtin redirect, not a subshell, so it is allowed here.

DOTFILES_DEV_FLAG="$HOME/.dotfiles-dev-mode"

# Resolve the active root into REPLY, applying precedence:
#   DOTFILES_USE_DEV (test subshell) > persistent flag file > $DOTFILES_HOME
# Falls back to $DOTFILES_HOME when the selected directory is missing.
# Assigns REPLY rather than printing so .zshenv can route startup without a
# subshell fork.
_dotfiles_resolve_root() {
  if [[ -n "$DOTFILES_USE_DEV" ]]; then
    REPLY="$DOTFILES_USE_DEV"
  elif [[ -f "$DOTFILES_DEV_FLAG" ]]; then
    REPLY="$(<"$DOTFILES_DEV_FLAG")"
  else
    REPLY="$DOTFILES_HOME"
  fi

  [[ -d "$REPLY" ]] || REPLY="$DOTFILES_HOME"
}

# Persist the active root and relink in one step, so the flag file and the
# installed symlinks can't disagree. An empty root clears persistent dev mode
# and relinks to the installed home.
_dotfiles_switch_root() {
  local root="$1"
  if [[ -n "$root" ]]; then
    print -r -- "$root" > "$DOTFILES_DEV_FLAG"
  else
    rm -f "$DOTFILES_DEV_FLAG"
    root="$DOTFILES_HOME"
  fi
  "$root/scripts/install-symlinks" "$root"
}
