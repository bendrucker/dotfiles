#!/usr/bin/env bash

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

if [ -z "$CI" ]; then
  sudo softwareupdate -i -a
fi

shopt -s extglob

for file in "$ZSH"/macos/!(install).sh
do
  bash "$file"
done

# Setup dotfiles-sync launchd job (only if not using symlink-based setup)
setup_dotfiles_sync() {
  local plist_name="com.user.dotfiles-sync.plist"
  local plist_src="$ZSH/macos/$plist_name"
  local plist_dst="$HOME/Library/LaunchAgents/$plist_name"

  if [[ ! -f "$plist_src" ]]; then
    echo "  launchd plist not found, skipping sync setup"
    return
  fi

  echo "  Setting up daily dotfiles sync..."

  mkdir -p "$HOME/Library/LaunchAgents"

  # Unload existing job if present
  launchctl unload "$plist_dst" 2>/dev/null || true

  # Copy plist (don't symlink - needs to work even if dotfiles break)
  cp "$plist_src" "$plist_dst"

  # Load the job
  if launchctl load "$plist_dst" 2>/dev/null; then
    echo "  ✓ launchd job installed"
  else
    echo "  ⚠ Failed to load launchd job (may need re-login)"
  fi
}

# Only setup sync if we're in separate-directory mode (not a symlink)
if [[ ! -L "$HOME/.dotfiles" ]]; then
  setup_dotfiles_sync
fi