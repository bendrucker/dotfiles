#!/usr/bin/env sh

set -e

TOPIC_DIR="$(cd "$(dirname "$0")" && pwd)"

# Yazi: install the pinned catppuccin flavors listed in package.toml into
# ~/.config/yazi/flavors/. Cross-platform, so it runs before the macOS gate.
if command -v ya >/dev/null 2>&1; then
  ya pkg install >/dev/null
fi

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

# iTerm2 (macOS)
defaults write com.googlecode.iterm2.plist PrefsCustomFolder -string "$TOPIC_DIR"
defaults write com.googlecode.iterm2.plist LoadPrefsFromCustomFolder -bool true
