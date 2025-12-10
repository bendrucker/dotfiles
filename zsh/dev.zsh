# Dotfiles development helpers
# These functions help switch between installed and development dotfiles

# Start a subshell using development dotfiles
function dotfiles-test() {
  if [[ ! -d "$DOTFILES_DEV" ]]; then
    echo "Development dotfiles not found at $DOTFILES_DEV"
    echo "Run: ~/.dotfiles/scripts/setup"
    return 1
  fi

  echo "Starting test shell with development dotfiles..."
  echo "  Source: $DOTFILES_DEV"
  echo "  Exit this shell to return to normal"
  echo ""
  DOTFILES_USE_DEV=1 exec zsh
}

# Toggle persistent dev mode
function dotfiles-dev-mode() {
  local flag="$HOME/.dotfiles-dev-mode"

  if [[ "$1" == "on" ]]; then
    touch "$flag"
    echo "Dev mode enabled. Restart shell to use development dotfiles."
  elif [[ "$1" == "off" ]]; then
    rm -f "$flag"
    echo "Dev mode disabled. Restart shell to use installed dotfiles."
  elif [[ -f "$flag" ]]; then
    rm "$flag"
    echo "Dev mode disabled. Restart shell to use installed dotfiles."
  else
    touch "$flag"
    echo "Dev mode enabled. Restart shell to use development dotfiles."
  fi
}

# Show current dotfiles status
function dotfiles-status() {
  echo "Dotfiles Status"
  echo "==============="
  echo ""
  echo "Active:      $ZSH"

  if [[ "$ZSH" == "$DOTFILES_DEV" ]]; then
    echo "Mode:        development"
  elif [[ "$ZSH" == "$DOTFILES_HOME" ]]; then
    echo "Mode:        installed"
  else
    echo "Mode:        custom/legacy"
  fi

  echo ""
  echo "Directories:"

  if [[ -d "$DOTFILES_HOME/.git" ]]; then
    local home_rev=$(git -C "$DOTFILES_HOME" rev-parse --short HEAD 2>/dev/null)
    local home_date=$(git -C "$DOTFILES_HOME" log -1 --format=%cr 2>/dev/null)
    echo "  Installed:   $DOTFILES_HOME ($home_rev, $home_date)"
  elif [[ -L "$DOTFILES_HOME" ]]; then
    echo "  Installed:   $DOTFILES_HOME -> $(readlink "$DOTFILES_HOME") (symlink - legacy)"
  else
    echo "  Installed:   $DOTFILES_HOME (not found)"
  fi

  if [[ -d "$DOTFILES_DEV/.git" ]]; then
    local dev_rev=$(git -C "$DOTFILES_DEV" rev-parse --short HEAD 2>/dev/null)
    local dev_date=$(git -C "$DOTFILES_DEV" log -1 --format=%cr 2>/dev/null)
    echo "  Development: $DOTFILES_DEV ($dev_rev, $dev_date)"
  else
    echo "  Development: $DOTFILES_DEV (not found)"
  fi

  if [[ -f "$HOME/.dotfiles-dev-mode" ]]; then
    echo ""
    echo "Note: Persistent dev mode is ON (~/.dotfiles-dev-mode exists)"
  fi
}

# Manual sync of installed dotfiles
function dotfiles-sync() {
  if [[ -x "$DOTFILES_HOME/bin/dotfiles-sync" ]]; then
    "$DOTFILES_HOME/bin/dotfiles-sync" "$@"
  else
    echo "Sync script not found - pulling directly..."
    git -C "$DOTFILES_HOME" pull --ff-only
  fi
}

# Open development dotfiles in editor
function dotfiles-edit() {
  ${EDITOR:-code} "$DOTFILES_DEV"
}
