#!/usr/bin/env bash

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

shopt -s extglob

for file in "$ZSH"/macos/!(install).sh
do
  bash "$file"
done

# shellcheck source=lib/launch-agent.sh
source "$ZSH/macos/lib/launch-agent.sh"

setup_dotfiles_upgrade() {
  # Remove old sync job (replaced by upgrade job which includes sync)
  # EXPIRES: 2026-10-26 every machine has run the upgrade job at least once
  local old_sync_plist="$HOME/Library/LaunchAgents/com.user.dotfiles-sync.plist"
  launchctl bootout "gui/$UID/com.user.dotfiles-sync" 2>/dev/null || true
  rm -f "$old_sync_plist"

  install_launch_agent com.user.dotfiles-upgrade.plist "nightly dotfiles upgrade"
}

setup_worktree_prune() {
  install_launch_agent com.user.worktree-prune.plist "nightly worktree prune"
}

setup_claude_upgrade() {
  # Remove old plist that pointed to ~/.claude-repo/bin/claude-upgrade
  # EXPIRES: 2026-10-26 every machine has the relocated claude-upgrade plist
  launchctl bootout "gui/$UID/com.user.claude-upgrade" 2>/dev/null || true

  install_launch_agent com.user.claude-upgrade.plist "nightly Claude upgrade"
}

# The theme-sync watcher is core functionality, so it runs in every mode.
# The plist resolves $HOME/.dotfiles, which works for both symlink and
# separate-directory installs.
install_launch_agent com.user.theme-sync.plist "theme-sync watcher"

# aw-qt supervises the ActivityWatch capture stack. This LaunchAgent is the sole
# autostart, so leave AW's built-in login item disabled to avoid a double launch.
install_launch_agent com.user.activitywatch.plist "ActivityWatch capture"

# Recompose the agent detection overrides when herdr fetches a manifest, rather
# than leaving a new one shadowed until the nightly install. The job no-ops on a
# machine without herdr, so it installs in every mode like the watcher above.
install_launch_agent com.user.herdr-agent-detection.plist "herdr agent detection watcher"

# The Screen Time import agent is installed by activitywatch/install.sh, which
# is where its binary comes from.

# Only setup upgrade if we're in separate-directory mode (not a symlink)
if [[ ! -L "$HOME/.dotfiles" ]]; then
  setup_dotfiles_upgrade
  setup_claude_upgrade
  setup_worktree_prune
fi

# Exit nonzero if any agent failed to load, so the failure is not swallowed by
# a zero exit. install_launch_agent already logs which one and how to recover.
exit "${launchd_failed:-0}"
