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
  dev       Toggle persistent development mode (repoints symlinks)
  sync      Sync installed dotfiles from remote
  help      Show this help message

Directories:
  Installed:  $DOTFILES_HOME
  Active:     $ZSH
EOF
}

_dotfiles_detect_repo() {
  local dir="${1:-$(pwd -P)}"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/scripts/bootstrap" && -d "$dir/zsh" ]]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

_dotfiles_repoint_symlinks() {
  local target="$1"
  local src dst

  for src in "$target"/**/*.symlink(N); do
    dst="$HOME/.$(basename "${src%.*}")"
    [[ -L "$dst" ]] && ln -sfn "$src" "$dst"
  done

  if [[ -f "$target/ssh/config" && -L "$HOME/.ssh/config" ]]; then
    ln -sfn "$target/ssh/config" "$HOME/.ssh/config"
  fi
}

_dotfiles_status() {
  echo "Dotfiles Status"
  echo "==============="

  if [[ "$ZSH" == "$DOTFILES_HOME" ]]; then
    echo "Mode:    installed"
  else
    echo "Mode:    development"
  fi

  if [[ -d "$DOTFILES_HOME/.git" ]]; then
    local home_rev
    home_rev=$(git -C "$DOTFILES_HOME" rev-parse --short HEAD 2>/dev/null)
    echo "Home:    $DOTFILES_HOME ($home_rev)"
  elif [[ -L "$DOTFILES_HOME" ]]; then
    echo "Home:    $DOTFILES_HOME -> $(readlink "$DOTFILES_HOME") (symlink)"
  fi

  if [[ "$ZSH" != "$DOTFILES_HOME" && -d "$ZSH/.git" ]]; then
    local dev_rev
    dev_rev=$(git -C "$ZSH" rev-parse --short HEAD 2>/dev/null)
    echo "Dev:     $ZSH ($dev_rev)"
  fi

  if [[ -d "$DOTFILES_HOME/.git" ]]; then
    local commit_time
    commit_time=$(git -C "$DOTFILES_HOME" log -1 --format=%cI 2>/dev/null)
    if [[ -n "$commit_time" ]]; then
      echo "Synced:  $commit_time"
    fi
  fi

  if [[ -f "$HOME/.dotfiles-dev-mode" ]]; then
    echo ""
    echo "Persistent dev mode: $(<"$HOME/.dotfiles-dev-mode")"
  fi
}

_dotfiles_test() {
  local dev_dir
  dev_dir="$(_dotfiles_detect_repo)" || {
    echo "Not inside a dotfiles repository or worktree."
    return 1
  }

  echo "Starting test shell with dotfiles from: $dev_dir"
  echo "Exit to return to normal."
  echo ""
  DOTFILES_USE_DEV="$dev_dir" exec zsh
}

_dotfiles_dev() {
  local flag="$HOME/.dotfiles-dev-mode"

  case "$1" in
    enable)
      local dev_dir
      dev_dir="$(_dotfiles_detect_repo)" || {
        echo "Not inside a dotfiles repository or worktree."
        return 1
      }
      echo "$dev_dir" > "$flag"
      _dotfiles_repoint_symlinks "$dev_dir"
      echo "Dev mode enabled: $dev_dir"
      echo "Restart shell to load dev zsh files."
      ;;
    disable)
      rm -f "$flag"
      _dotfiles_repoint_symlinks "$DOTFILES_HOME"
      echo "Dev mode disabled. Symlinks restored to $DOTFILES_HOME"
      echo "Restart shell to apply."
      ;;
    "")
      if [[ -f "$flag" ]]; then
        _dotfiles_dev disable
      else
        _dotfiles_dev enable
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
