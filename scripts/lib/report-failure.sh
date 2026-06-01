# shellcheck shell=bash
# Sourceable failure reporting for unattended jobs.
#
# notify <title> <message> [sound]
#   Darwin-guarded osascript notification (default sound: Basso).
#
# report_failure <job> <title> <command> <output> <revision> [extra_meta]
#   File a Things to-do describing the failure and notify, but only on the
#   transition into a failed state. A per-job latch under
#   ${XDG_STATE_HOME:-$HOME/.local/state}/dotfiles/<job>.status records ok
#   or failed; while a job stays broken the latch suppresses duplicate
#   to-dos. report_success resets it so the next break files a fresh one.
#   <command> is the shell snippet shown in the to-do for reproduction;
#   <output> is the captured log; <extra_meta> is optional extra metadata
#   markdown appended to the host/time/revision header.
#
# report_success <job>
#   Clear the latch.

notify() {
  local title="$1"
  local message="$2"
  local sound="${3:-Basso}"

  [[ "$(uname)" == "Darwin" ]] || return 0
  osascript -e "display notification \"$message\" with title \"$title\" sound name \"$sound\"" 2>/dev/null || true
}

report_status_file() {
  local job="$1"
  local dir="${XDG_STATE_HOME:-$HOME/.local/state}/dotfiles"
  mkdir -p "$dir"
  echo "$dir/$job.status"
}

report_success() {
  local job="$1"
  echo ok >"$(report_status_file "$job")"
}

report_failure() {
  local job="$1"
  local title="$2"
  local command="$3"
  local output="$4"
  local revision="$5"
  local extra_meta="$6"

  local status_file prior
  status_file=$(report_status_file "$job")
  prior=$(cat "$status_file" 2>/dev/null)
  echo failed >"$status_file"

  if [[ "$prior" == "failed" ]]; then
    gum log --level info "$job still failing - to-do already filed, staying quiet"
    return 0
  fi

  gum log --level info "Creating Things to-do for $job failure"

  local host time
  host=$(hostname -s)
  time=$(date "+%Y-%m-%d %H:%M:%S %Z")

  local notes='- **Host:** '"$host"'
- **Time:** '"$time"'
- **Revision:** '"$revision"
  [[ -n "$extra_meta" ]] && notes+='
'"$extra_meta"
  notes+='

```sh
'"$command"'
```

## Error Output
```
'"$output"'
```'

  local encoded_notes encoded_title
  encoded_notes=$(echo "$notes" | jq -sRr @uri)
  encoded_title=$(echo "$title" | jq -sRr @uri)

  open "things:///add?title=${encoded_title}&notes=${encoded_notes}&when=today"

  notify "$title" "$job failed - see Things to-do"
}
