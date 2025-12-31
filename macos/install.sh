#!/usr/bin/env bash

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

# Software update requires sudo, skip in non-interactive mode
if [ -z "$CI" ] && [ -z "${NONINTERACTIVE-}" ]; then
  sudo softwareupdate -i -a
fi

shopt -s extglob

for file in "$ZSH"/macos/!(install).sh
do
  bash "$file"
done

setup_dotfiles_upgrade() {
  # Remove old sync job (replaced by upgrade job which includes sync)
  local old_sync_plist="$HOME/Library/LaunchAgents/com.user.dotfiles-sync.plist"
  launchctl unload "$old_sync_plist" 2>/dev/null || true
  rm -f "$old_sync_plist"

  local plist_name="com.user.dotfiles-upgrade.plist"
  local plist_src="$ZSH/macos/$plist_name"
  local plist_dst="$HOME/Library/LaunchAgents/$plist_name"

  if [[ ! -f "$plist_src" ]]; then
    echo "  launchd plist not found, skipping upgrade setup"
    return
  fi

  echo "  Setting up nightly dotfiles upgrade..."

  mkdir -p "$HOME/Library/LaunchAgents"

  launchctl unload "$plist_dst" 2>/dev/null || true

  cp "$plist_src" "$plist_dst"

  if launchctl load "$plist_dst" 2>/dev/null; then
    echo "  ✓ upgrade launchd job installed"
  else
    echo "  ⚠ Failed to load upgrade launchd job (may need re-login)"
  fi
}

# Only setup upgrade if we're in separate-directory mode (not a symlink)
if [[ ! -L "$HOME/.dotfiles" ]]; then
  setup_dotfiles_upgrade
fi