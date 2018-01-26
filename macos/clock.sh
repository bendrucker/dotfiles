#!/usr/bin/env sh

# 24 hour time
defaults write -g AppleICUForce24HourTime -bool true

# monday: first day of week
defaults write -g AppleFirstWeekday -dict gregorian 2

# reloads menu bar
killall SystemUIServer