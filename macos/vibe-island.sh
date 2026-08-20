#!/usr/bin/env bash

# Vibe Island manages Claude Code's hooks by writing ~/.claude/settings.json
# itself. It follows the dotfiles symlink and writes through it, so what lands
# is a dirty user/settings.json in the tracked ~/.claude-repo checkout. What it
# writes is the hook shape for a remote agent host, naming a binary that is only
# installed on machines the app SSHes into, so every hook event in a session
# started afterward fails.
#
# An earlier version replaced the symlink with a regular file instead, which
# left Claude Code reading a file no longer connected to the repo. Both are
# worth defending against, and they need different defenses: claude/install.sh
# restores a replaced symlink, while claude-upgrade reverts a write that came
# through one.
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

VIBE_ISLAND_APP="${VIBE_ISLAND_APP:-/Applications/Vibe Island.app}"
VIBE_ISLAND_DOMAIN="app.vibeisland.macos"
APP_WAIT_SECONDS=10

[ -d "$VIBE_ISLAND_APP" ] || exit 0

hook_auto_config() {
  defaults read "$VIBE_ISLAND_DOMAIN" hookAutoConfig_claude 2>/dev/null
}

app_running() {
  pgrep -x vibe-island >/dev/null 2>&1
}

# Wait for the app to reach a running state, or give up. Bounded in one place,
# so the quit and the relaunch cannot drift to different limits. Takes the
# state to wait for, and answers whether it arrived.
wait_for_app() {
  local want="$1" waited=0

  while [ "$waited" -lt "$APP_WAIT_SECONDS" ]; do
    if app_running; then
      [ "$want" = running ] && return 0
    else
      [ "$want" = gone ] && return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  return 1
}

# Ask the app to quit and wait for it to go, so the write lands while nothing
# holds a cached copy of the preference. Bounded: an app that will not quit must
# not hang the nightly install.
quit_app() {
  osascript -e 'quit app "Vibe Island"' >/dev/null 2>&1

  wait_for_app gone
}

# Already off. Stopping here skips quitting the app on a nightly run that has
# nothing to write.
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

wrote=1
defaults write "$VIBE_ISLAND_DOMAIN" hookAutoConfig_claude -bool false || wrote=""

if [ -z "$wrote" ]; then
  gum log --level warn "Could not write the Vibe Island preference. The opt-out did not take."
fi

[ -n "$quit" ] || exit 0

# This script took the menu bar away, so it owns putting it back, and owns
# saying when it could not. A failed reopen is the one outcome the user cannot
# discover on their own, and stderr on a nightly run goes to a log nobody reads,
# so it also goes to Notification Center.
if ! open -a "$VIBE_ISLAND_APP"; then
  gum log --level warn "Could not reopen Vibe Island. Open it to get the menu bar back."
  osascript -e 'display notification "Could not reopen it after applying a preference. Open it to get the menu bar back." with title "Vibe Island"' >/dev/null 2>&1
  exit 0
fi

# The app reads the preference at launch, so what it reports once it is up is
# what it means to honor. A value that is still not 0 means the app is ignoring
# the opt-out, and only claude-upgrade's revert can defend the config from
# there. A best-effort signal either way: an app slow to write its own value
# back reads as compliant here, and the revert's notification is the detector
# that does not depend on timing.
wait_for_app running || exit 0

# An unreadable preference is not the app overriding one. Blaming it for a read
# that never returned a value would point at the wrong defense, so the two get
# different messages.
current=$(hook_auto_config)
if [ -z "$current" ]; then
  gum log --level warn "Could not read the Vibe Island preference back after relaunching. Whether the opt-out took is unknown."
elif [ "$current" != 0 ]; then
  gum log --level warn "Vibe Island turned Claude hook management back on after relaunching. It is ignoring the opt-out."
fi
