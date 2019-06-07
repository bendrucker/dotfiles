#!/usr/bin/env sh

# hide desktop
defaults write com.apple.finder CreateDesktop -bool false

killall Finder
