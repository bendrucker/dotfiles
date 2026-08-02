#!/usr/bin/env bash
# Install a LaunchAgent from a plist in macos/. Shared because scripts/install
# does not order topic installers, so a topic must bootstrap its own agent.
#
# Sets launchd_failed=1 in the caller's scope so an installer can finish its
# remaining work and still exit nonzero.

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

  cp "$plist_src" "$plist_dst"

  # bootout of a running service is asynchronous. An immediate bootstrap can
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
    # shellcheck disable=SC2034 # read by the sourcing installer's exit status
    launchd_failed=1
    return 1
  fi
}

remove_launch_agent() {
  local plist_name="$1"
  local label="${plist_name%.plist}"

  launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$plist_name"
}
