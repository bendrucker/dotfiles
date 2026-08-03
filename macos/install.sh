#!/usr/bin/env bash

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

shopt -s extglob

for file in "$ZSH"/macos/!(install).sh
do
  bash "$file"
done

install_launch_agent() {
  local plist_name="$1"
  local description="$2"
  local plist_src="$ZSH/macos/$plist_name"
  local plist_dst="$HOME/Library/LaunchAgents/$plist_name"
  local label="${plist_name%.plist}"

  if [[ ! -f "$plist_src" ]]; then
    gum log --level warn "$description plist not found, skipping"
    return
  fi

  gum log --level info "setting up $description"

  mkdir -p "$HOME/Library/LaunchAgents"

  launchctl bootout "gui/$UID/$label" 2>/dev/null || true

  # launchd expands nothing outside ProgramArguments, which the shell handles,
  # so keys it reads itself (WatchPaths) carry __HOME__ and get it here.
  sed "s|__HOME__|$HOME|g" "$plist_src" >"$plist_dst"

  # bootout of a running service is asynchronous; an immediate bootstrap can
  # race the teardown and fail, so retry briefly.
  local _attempt
  for _attempt in 1 2 3 4 5; do
    launchctl bootstrap "gui/$UID" "$plist_dst" 2>/dev/null && break
    sleep 0.5
  done

  if launchctl print "gui/$UID/$label" >/dev/null 2>&1; then
    gum log --level info "$description launchd agent installed"
  else
    gum log --level error "$description launchd agent failed to load; run: launchctl bootstrap gui/$UID $plist_dst"
    launchd_failed=1
    return 1
  fi
}

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

# Only setup upgrade if we're in separate-directory mode (not a symlink)
if [[ ! -L "$HOME/.dotfiles" ]]; then
  setup_dotfiles_upgrade
  setup_claude_upgrade
  setup_worktree_prune
fi

# Exit nonzero if any agent failed to load, so the failure is not swallowed by
# a zero exit. install_launch_agent already logs which one and how to recover.
exit "${launchd_failed:-0}"
