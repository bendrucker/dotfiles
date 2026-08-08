# shellcheck shell=bash
# LaunchAgent installation, sourced by macos/install.sh.
#
# The nightly com.user.dotfiles-upgrade job runs scripts/install, so this code
# routinely runs as a descendant of a job it is about to reinstall. launchctl
# bootout tears down the job's whole process tree, so reinstalling that label
# kills the run partway: the bootstrap that would put the job back never
# executes, launchd is left without it, and nothing reports the failure because
# the reporting code died with the rest of the tree.

# Does launchd hold a job for this label?
launch_agent_loaded() {
  launchctl print "gui/$UID/$1" >/dev/null 2>&1
}

# Is this process part of the job for this label? launchd puts XPC_SERVICE_NAME
# in the job's own environment, but libxpc rewrites it on every exec, so a
# descendant as deep as a topic installer is only recognized by the pid walk.
launch_agent_is_self() {
  local label="$1"

  [[ "${XPC_SERVICE_NAME:-}" == "$label" ]] && return 0

  local job_pid
  job_pid=$(launchctl print "gui/$UID/$label" 2>/dev/null |
    awk '$1 == "pid" && $2 == "=" { print $3; exit }')
  [[ -n "$job_pid" ]] || return 1

  local pid=$$
  while [[ -n "$pid" ]] && [[ "$pid" -gt 1 ]]; do
    [[ "$pid" == "$job_pid" ]] && return 0
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')
  done

  return 1
}

# What installing a label should do, given whether the rendered plist already
# matches the installed one, whether launchd has the job, and whether this
# process is running under that job.
#
#   skip       leave the file and launchd alone
#   defer      write the plist and leave the running job on its old config
#   bootstrap  write and load, with nothing to tear down first
#   reinstall  tear the job down and load it again
launch_agent_plan() {
  local unchanged="$1" loaded="$2" is_self="$3"

  if ((unchanged && loaded)); then
    echo skip
  elif ((is_self && loaded)); then
    echo defer
  elif ((!loaded)); then
    echo bootstrap
  else
    echo reinstall
  fi
}

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

  mkdir -p "$HOME/Library/LaunchAgents"

  # launchd expands nothing outside ProgramArguments, which the shell handles,
  # so keys it reads itself (WatchPaths) carry __HOME__ and get it here.
  local rendered
  rendered=$(sed "s|__HOME__|$HOME|g" "$plist_src")

  local unchanged=0 loaded=0 is_self=0
  [[ -f "$plist_dst" ]] && [[ "$rendered" == "$(cat "$plist_dst")" ]] && unchanged=1
  launch_agent_loaded "$label" && loaded=1
  launch_agent_is_self "$label" && is_self=1

  local plan
  plan=$(launch_agent_plan "$unchanged" "$loaded" "$is_self")

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
    gum log --level warn "$description launchd agent is the job running this install, so it keeps its old config; it picks the new one up at next login, or now via: launchctl bootout gui/$UID/$label && launchctl bootstrap gui/$UID $plist_dst"
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
    gum log --level error "$description launchd agent failed to load; run: launchctl bootstrap gui/$UID $plist_dst"
    # shellcheck disable=SC2034 # macos/install.sh exits on this
    launchd_failed=1
    return 1
  fi
}
