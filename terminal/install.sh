#!/usr/bin/env sh

set -e

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

TOPIC_DIR="$(cd "$(dirname "$0")" && pwd)"

# iTerm2 (macOS)
defaults write com.googlecode.iterm2.plist PrefsCustomFolder -string "$TOPIC_DIR"
defaults write com.googlecode.iterm2.plist LoadPrefsFromCustomFolder -bool true
