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

  # The links now resolve into a different tree, so anything already running is
  # holding the config of the root we just left. Every reload is in place, so a
  # mode toggle costs no sessions. Guarded because the root being switched to
  # can be a checkout predating this script.
  # Downgraded to a warning, as in scripts/install and bin/dotfiles-sync: the
  # flag and the symlinks have already moved, so the switch succeeded whatever
  # the reload did, and returning its status would report otherwise.
  if [[ -x "$root/bin/dotfiles-reload" ]]; then
    "$root/bin/dotfiles-reload" || gum log --level warn "some config reloads had issues"
  fi
}
