# shellcheck shell=bash
# LaunchAgent installation for a job whose process must outlive installs, which
# mise's launchd support cannot express: it boots out any agent whose plist
# changed. herdr/install.sh is the caller, for the server that owns every pane.

# What installing a label should do, given whether the rendered plist already
# matches the installed one, whether launchd has the job, and whether the caller
# holds a live process that neither a bootout nor a second copy may disturb.
#
#   skip       leave the file and launchd alone
#   defer      write the plist and leave launchd as it is
#   bootstrap  write and load, with nothing to tear down first
#   reinstall  tear the job down and load it again
launch_agent_plan() {
  local unchanged="$1" loaded="$2" hold="${3:-0}"

  if ((unchanged && loaded)); then
    echo skip
  elif ((hold)); then
    echo defer
  elif ((!loaded)); then
    echo bootstrap
  else
    echo reinstall
  fi
}

# Passing hold=1 writes the plist without touching launchd.
install_launch_agent() {
  local plist_path="$1"
  local description="$2"
  local hold="${3:-0}"
  local plist_name="${plist_path##*/}"
  local plist_src="$ZSH/$plist_path"
  local plist_dst="$HOME/Library/LaunchAgents/$plist_name"
  local label="${plist_name%.plist}"

  if [[ ! -f "$plist_src" ]]; then
    gum log --level warn "$description plist not found, skipping"
    return
  fi

  mkdir -p "$HOME/Library/LaunchAgents"

  # launchd expands nothing outside ProgramArguments, which the shell handles,
  # so keys it reads itself carry __HOME__ and get it here.
  local rendered
  rendered=$(sed "s|__HOME__|$HOME|g" "$plist_src")

  local unchanged=0 loaded=0
  [[ -f "$plist_dst" ]] && [[ "$rendered" == "$(cat "$plist_dst")" ]] && unchanged=1
  launchctl print "gui/$UID/$label" >/dev/null 2>&1 && loaded=1

  local plan
  plan=$(launch_agent_plan "$unchanged" "$loaded" "$hold")

  if [[ "$plan" == skip ]]; then
    gum log --level info "$description launchd agent already current"
    return
  fi

  gum log --level info "setting up $description"

  if [[ "$plan" == reinstall ]]; then
    launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  fi

  printf '%s\n' "$rendered" >"$plist_dst"

  if [[ "$plan" == defer ]]; then
    gum log --level warn "$description is running, so launchd was left alone. The plist written takes effect at next login, or now by stopping it and running: launchctl bootout gui/$UID/$label; launchctl bootstrap gui/$UID $plist_dst"
    return
  fi

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
    gum log --level error "$description launchd agent failed to load. Run: launchctl bootstrap gui/$UID $plist_dst"
    return 1
  fi
}
