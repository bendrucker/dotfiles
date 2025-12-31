# shellcheck shell=bash
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
      _dotfiles_test "$@"
      ;;
    dev)
      _dotfiles_dev "$@"
      ;;
    sync)
      _dotfiles_sync "$@"
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
Usage: dotfiles <command>

Commands:
  status    Show which dotfiles are active and their versions
  test      Start a subshell using development dotfiles
  dev       Toggle persistent development mode
  sync      Sync installed dotfiles from remote
  help      Show this help message

Directories:
  Installed:    $DOTFILES_HOME
  Development:  $DOTFILES_DEV
EOF
}

_dotfiles_status() {
  echo "Dotfiles Status"
  echo "==============="

  if [[ "$ZSH" == "$DOTFILES_DEV" ]]; then
    echo "Mode:    development"
  elif [[ "$ZSH" == "$DOTFILES_HOME" ]]; then
    echo "Mode:    installed"
  else
    echo "Mode:    custom ($ZSH)"
  fi

  if [[ -d "$DOTFILES_HOME/.git" ]]; then
    local home_rev
    home_rev=$(git -C "$DOTFILES_HOME" rev-parse --short HEAD 2>/dev/null)
    echo "Home:    $DOTFILES_HOME ($home_rev)"
  elif [[ -L "$DOTFILES_HOME" ]]; then
    echo "Home:    $DOTFILES_HOME -> $(readlink "$DOTFILES_HOME") (symlink)"
  fi

  if [[ -d "$DOTFILES_DEV/.git" ]]; then
    local dev_rev
    dev_rev=$(git -C "$DOTFILES_DEV" rev-parse --short HEAD 2>/dev/null)
    echo "Dev:     $DOTFILES_DEV ($dev_rev)"
  fi

  local state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/dotfiles"
  local last_sync="$state_dir/last-sync"
  if [[ -f "$last_sync" ]]; then
    local sync_time
    sync_time=$(cat "$last_sync" 2>/dev/null)
    echo "Synced:  $sync_time"
  fi

  if [[ -f "$HOME/.dotfiles-dev-mode" ]]; then
    echo ""
    echo "Note: Persistent dev mode is ON (~/.dotfiles-dev-mode exists)"
  fi
}

_dotfiles_test() {
  if [[ ! -d "$DOTFILES_DEV" ]]; then
    echo "Development dotfiles not found at $DOTFILES_DEV"
    echo "Run: scripts/setup"
    return 1
  fi

  echo "Starting test shell with development dotfiles..."
  echo "Exit to return to normal."
  echo ""
  DOTFILES_USE_DEV=1 exec zsh
}

_dotfiles_dev() {
  local flag="$HOME/.dotfiles-dev-mode"

  case "$1" in
    enable)
      touch "$flag"
      echo "Dev mode enabled. Restart shell to apply."
      ;;
    disable)
      rm -f "$flag"
      echo "Dev mode disabled. Restart shell to apply."
      ;;
    "")
      if [[ -f "$flag" ]]; then
        rm "$flag"
        echo "Dev mode disabled. Restart shell to apply."
      else
        touch "$flag"
        echo "Dev mode enabled. Restart shell to apply."
      fi
      ;;
    *)
      echo "Usage: dotfiles dev [enable|disable]"
      return 1
      ;;
  esac
}

_dotfiles_sync() {
  if [[ -x "$DOTFILES_HOME/bin/dotfiles-sync" ]]; then
    "$DOTFILES_HOME/bin/dotfiles-sync" "$@"
  else
    echo "Sync script not found - pulling directly..."
    git -C "$DOTFILES_HOME" pull --ff-only
  fi
}

# Completion (variables set by zsh completion system)
# shellcheck disable=SC2034,SC2154
_dotfiles() {
  local -a commands=(
    'status:Show which dotfiles are active'
    'test:Start a subshell using development dotfiles'
    'dev:Toggle persistent development mode'
    'sync:Sync installed dotfiles from remote'
    'help:Show help message'
  )

  _arguments -C '1: :->command' '*::arg:->args'

  case $state in
    command)
      _describe -t commands 'dotfiles command' commands
      ;;
    args)
      case ${words[1]} in
        dev)
          _arguments '1:mode:(enable disable)'
          ;;
        sync)
          _arguments '--bootstrap[Run bootstrap after sync]'
          ;;
      esac
      ;;
  esac
}

compdef _dotfiles dotfiles
