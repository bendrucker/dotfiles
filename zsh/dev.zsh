# Dotfiles management command
# Provides subcommands for managing installed and development dotfiles

dotfiles() {
  local cmd="$1"
  shift 2>/dev/null || true

  case "$cmd" in
    status|st)
      _dotfiles_status
      ;;
    test|t)
      _dotfiles_test
      ;;
    dev)
      _dotfiles_dev "$@"
      ;;
    sync)
      _dotfiles_sync "$@"
      ;;
    edit|e)
      _dotfiles_edit
      ;;
    cd)
      _dotfiles_cd "$@"
      ;;
    help|--help|-h|"")
      _dotfiles_help
      ;;
    *)
      echo "Unknown command: $cmd"
      echo "Run 'dotfiles help' for usage"
      return 1
      ;;
  esac
}

_dotfiles_help() {
  cat <<EOF
Usage: dotfiles <command> [options]

Commands:
  status, st    Show which dotfiles are active and their versions
  test, t       Start a subshell using development dotfiles
  dev [enable|disable]  Toggle persistent development mode
  sync          Sync installed dotfiles from remote
  edit, e       Open development dotfiles in editor
  cd [dev|home] Change to dotfiles directory (dev by default)
  help          Show this help message

Directories:
  Installed:    $DOTFILES_HOME
  Development:  $DOTFILES_DEV
EOF
}

_dotfiles_status() {
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

_dotfiles_test() {
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

_dotfiles_dev() {
  local flag="$HOME/.dotfiles-dev-mode"

  if [[ "$1" == "enable" ]]; then
    touch "$flag"
    echo "Dev mode enabled. Restart shell to use development dotfiles."
  elif [[ "$1" == "disable" ]]; then
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

_dotfiles_sync() {
  if [[ -x "$DOTFILES_HOME/bin/dotfiles-sync" ]]; then
    "$DOTFILES_HOME/bin/dotfiles-sync" "$@"
  else
    echo "Sync script not found - pulling directly..."
    git -C "$DOTFILES_HOME" pull --ff-only
  fi
}

_dotfiles_edit() {
  ${EDITOR:-code} "$DOTFILES_DEV"
}

_dotfiles_cd() {
  case "$1" in
    home|installed)
      cd "$DOTFILES_HOME"
      ;;
    dev|development|"")
      cd "$DOTFILES_DEV"
      ;;
    *)
      echo "Unknown target: $1 (use 'dev' or 'home')"
      return 1
      ;;
  esac
}

# Completion function
_dotfiles() {
  local line state

  local -a commands=(
    'status:Show which dotfiles are active and their versions'
    'st:Show which dotfiles are active (alias for status)'
    'test:Start a subshell using development dotfiles'
    't:Start a test subshell (alias for test)'
    'dev:Toggle persistent development mode'
    'sync:Sync installed dotfiles from remote'
    'edit:Open development dotfiles in editor'
    'e:Open in editor (alias for edit)'
    'cd:Change to dotfiles directory'
    'help:Show help message'
  )

  _arguments -C \
    '1: :->command' \
    '*::arg:->args'

  case $state in
    command)
      _describe -t commands 'dotfiles command' commands
      ;;
    args)
      case ${line[1]} in
        dev)
          _arguments '1:mode:(enable disable)'
          ;;
        cd)
          _arguments '1:target:(dev home)'
          ;;
        sync)
          _arguments '--bootstrap[Run bootstrap after sync]'
          ;;
        *)
          _message 'no more arguments'
          ;;
      esac
      ;;
  esac
}

compdef _dotfiles dotfiles
