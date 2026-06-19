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

  if [[ ! -f "$plist_src" ]]; then
    gum log --level warn "$description plist not found, skipping"
    return
  fi

  gum log --level info "setting up $description"

  mkdir -p "$HOME/Library/LaunchAgents"

  launchctl unload "$plist_dst" 2>/dev/null || true

  cp "$plist_src" "$plist_dst"

  if launchctl load "$plist_dst" 2>/dev/null; then
    gum log --level info "$description launchd agent installed"
  else
    gum log --level warn "failed to load $description launchd agent; may need re-login"
  fi
}

setup_dotfiles_upgrade() {
  # Remove old sync job (replaced by upgrade job which includes sync)
  local old_sync_plist="$HOME/Library/LaunchAgents/com.user.dotfiles-sync.plist"
  launchctl unload "$old_sync_plist" 2>/dev/null || true
  rm -f "$old_sync_plist"

  install_launch_agent com.user.dotfiles-upgrade.plist "nightly dotfiles upgrade"
}

setup_worktree_prune() {
  install_launch_agent com.user.worktree-prune.plist "nightly worktree prune"
}

setup_claude_upgrade() {
  # Remove old plist that pointed to ~/.claude-repo/bin/claude-upgrade
  local old_plist="$HOME/Library/LaunchAgents/com.user.claude-upgrade.plist"
  launchctl unload "$old_plist" 2>/dev/null || true

  install_launch_agent com.user.claude-upgrade.plist "nightly Claude upgrade"
}

# The theme-sync watcher is core functionality, so it runs in every mode.
# The plist resolves $HOME/.dotfiles, which works for both symlink and
# separate-directory installs.
install_launch_agent com.user.theme-sync.plist "theme-sync watcher"

# Only setup upgrade if we're in separate-directory mode (not a symlink)
if [[ ! -L "$HOME/.dotfiles" ]]; then
  setup_dotfiles_upgrade
  setup_claude_upgrade
  setup_worktree_prune
fi
