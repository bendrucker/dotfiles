#!/usr/bin/env bash

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

shopt -s extglob

for file in "$ZSH"/macos/!(install).sh
do
  bash "$file"
done

# The old nightly job keeps running until its replacement has loaded, so a
# failed install leaves one in place to retry. Disabled rather than booted out,
# since it is usually the job running this install.
# EXPIRES: 2027-04-08 every machine has run scripts/install since the move
if launchctl print "gui/$UID/dev.mise.dotfiles-upgrade" >/dev/null 2>&1; then
  launchctl disable "gui/$UID/com.user.dotfiles-upgrade" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/com.user.dotfiles-upgrade.plist"
fi
