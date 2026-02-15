#!/usr/bin/env sh

set -e

TOPIC_DIR="$(cd "$(dirname "$0")" && pwd)"

# TPM (Tmux Plugin Manager)
TPM_DIR="$HOME/.tmux/plugins/tpm"
if [ ! -d "$TPM_DIR" ]; then
  git clone https://github.com/tmux-plugins/tpm "$TPM_DIR"
fi
"$TPM_DIR/bin/install_plugins"
"$TPM_DIR/bin/update_plugins" all
"$TPM_DIR/bin/clean_plugins"

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
