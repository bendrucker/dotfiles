#!/usr/bin/env bash

# Vibe Island manages Claude Code's hooks by writing ~/.claude/settings.json
# itself. It writes with an atomic rename, which replaces the dotfiles symlink
# with a regular file, so Claude Code silently stops reading the tracked config
# in ~/.claude-repo and every later edit there goes nowhere.
#
# This preference opts out of that management, recording a standing choice so a
# new machine does not arrive with the app owning the hook config again. Opting
# out is not passive: the app removes its hook entries from settings.json rather
# than leaving behind whatever it last wrote.
#
# claude/install.sh restores the symlink when it finds one already replaced.
# This is what keeps it from being replaced again.

VIBE_ISLAND_APP="${VIBE_ISLAND_APP:-/Applications/Vibe Island.app}"
VIBE_ISLAND_DOMAIN="app.vibeisland.macos"

[ -d "$VIBE_ISLAND_APP" ] || exit 0

# Already off. Stopping here keeps the nightly install silent rather than
# warning about a running app on every run.
if [ "$(defaults read "$VIBE_ISLAND_DOMAIN" hookAutoConfig_claude 2>/dev/null)" = 0 ]; then
  exit 0
fi

defaults write "$VIBE_ISLAND_DOMAIN" hookAutoConfig_claude -bool false

# A running app holds its own cached copy of the preference and can write that
# copy back over this one, so the change is only reliable from the next launch.
# dock.sh and clock.sh kill the process to apply a change, which does not carry
# over: the Dock and SystemUIServer relaunch themselves, while quitting Vibe
# Island would take the user's menu bar with it until they reopened it.
if pgrep -x vibe-island >/dev/null 2>&1; then
  gum log --level warn "Vibe Island hook management disabled for Claude. Quit and reopen Vibe Island so it does not write the old value back."
fi
