#!/usr/bin/env sh

set -e

TOPIC_DIR="$(cd "$(dirname "$0")" && pwd)"

# Ghostty (cross-platform)
GHOSTTY_CONFIG="$HOME/.config/ghostty"
mkdir -p "$GHOSTTY_CONFIG"
ln -sf "$TOPIC_DIR/ghostty.config" "$GHOSTTY_CONFIG/config"

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

# iTerm2 (macOS)
defaults write com.googlecode.iterm2.plist PrefsCustomFolder -string "$TOPIC_DIR"
defaults write com.googlecode.iterm2.plist LoadPrefsFromCustomFolder -bool true
