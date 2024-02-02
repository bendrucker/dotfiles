#!/usr/bin/env sh

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

# Specify the preferences directory
defaults write com.googlecode.iterm2.plist PrefsCustomFolder -string "$ZSH/iterm"
# Tell iTerm2 to use the custom preferences in the directory
defaults write com.googlecode.iterm2.plist LoadPrefsFromCustomFolder -bool true
