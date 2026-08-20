#!/usr/bin/env bash

# Vibe Island manages Claude Code's hooks by writing ~/.claude/settings.json
# itself. It writes with an atomic rename, which replaces the dotfiles symlink
# with a regular file, so Claude Code silently stops reading the tracked config
# in ~/.claude-repo and every later edit there goes nowhere. What it writes is
# the hook shape for a remote agent host, naming a binary that is only installed
# on machines the app SSHes into, so every hook event in a session started
# afterward fails.
#
# This preference opts out of that management, recording a standing choice so a
# new machine does not arrive with the app owning the hook config again. Opting
# out is not passive: the app removes its hook entries from settings.json rather
# than leaving behind whatever it last wrote.
#
# A running app holds its own cached copy of the preference and can write that
# copy back, which is how an earlier opt-out was lost while this preference
# still read 0. So the app is quit before the write and reopened after it,
# rather than warned about. dock.sh and clock.sh kill their process to apply a
# change, which does not carry over: the Dock and SystemUIServer relaunch
# themselves, while Vibe Island has to be reopened or the user loses their menu
# bar.
#
# claude/install.sh restores the symlink when it finds one already replaced.
# This is what keeps it from being replaced again.

VIBE_ISLAND_APP="${VIBE_ISLAND_APP:-/Applications/Vibe Island.app}"
VIBE_ISLAND_DOMAIN="app.vibeisland.macos"

[ -d "$VIBE_ISLAND_APP" ] || exit 0

hook_auto_config() {
  defaults read "$VIBE_ISLAND_DOMAIN" hookAutoConfig_claude 2>/dev/null
}

app_running() {
  pgrep -x vibe-island >/dev/null 2>&1
}

# Ask the app to quit and wait for it to go, so the write lands while nothing
# holds a cached copy of the preference. Bounded: an app that will not quit must
# not hang the nightly install.
quit_app() {
  osascript -e 'quit app "Vibe Island"' >/dev/null 2>&1

  local waited=0
  while app_running && [ "$waited" -lt 10 ]; do
    sleep 1
    waited=$((waited + 1))
  done

  ! app_running
}

# Already off. Stopping here keeps the nightly install silent rather than
# quitting the app out from under the user on every run.
if [ "$(hook_auto_config)" = 0 ]; then
  exit 0
fi

quit=""
if app_running; then
  if quit_app; then
    quit=1
  else
    gum log --level warn "Vibe Island would not quit. It may write the old value back - quit and reopen it to apply the change."
  fi
fi

defaults write "$VIBE_ISLAND_DOMAIN" hookAutoConfig_claude -bool false

[ -n "$quit" ] || exit 0

open -a "$VIBE_ISLAND_APP"

# The app reads the preference at launch, so what it reports now is what it
# means to honor. A value that is still not 0 means it is ignoring the opt-out
# rather than caching over it, and only claude-upgrade's revert can defend the
# config from there.
sleep 2
if [ "$(hook_auto_config)" != 0 ]; then
  gum log --level warn "Vibe Island turned Claude hook management back on after relaunching. It is ignoring the opt-out."
fi
