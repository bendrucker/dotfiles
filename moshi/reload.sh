#!/usr/bin/env bash
#
# Restart the moshi-hook daemon when config.toml changed since the last restart
# this script applied. The daemon reads its settings only at startup, so a
# restart is the one way a change reaches it.
#
# This is the one reload.sh that restarts a server. A restart drops the
# daemon's phone connection for a few seconds and any approval in flight
# through it, and one in flight during the nightly upgrade is unlikely. A
# config change that never applies is the worse failure. The hash keeps an
# unchanged night from restarting it at all.
set -uo pipefail

command -v moshi-hook >/dev/null 2>&1 || exit 0

config="${XDG_CONFIG_HOME:-$HOME/.config}/moshi/config.toml"
[[ -f "$config" ]] || exit 0

stamp="${XDG_STATE_HOME:-$HOME/.local/state}/dotfiles/moshi-config.sha256"
current=$(shasum --algorithm 256 <"$config" | cut -d' ' -f1)
applied=$(cat "$stamp" 2>/dev/null || true)

if [[ "$current" == "$applied" ]]; then
  gum log --level info "moshi-hook: config.toml unchanged since the last restart, skipping"
  exit 0
fi

record() {
  mkdir -p "$(dirname "$stamp")" && printf '%s\n' "$current" >"$stamp"
}

# A stopped daemon reads the file when it next starts, so there is nothing to
# apply now and the change counts as applied.
if ! moshi-hook service status 2>/dev/null | grep --quiet 'state = running'; then
  gum log --level info "moshi-hook: config.toml changed but the daemon is not running, skipping restart"
  record
  exit 0
fi

gum log --level info "moshi-hook: config.toml changed, restarting the daemon"
# Recorded only after a restart that worked, so a failed one retries next run.
if ! moshi-hook service restart >/dev/null 2>&1; then
  gum log --level warn "moshi-hook: service restart failed, the daemon keeps its old config"
  exit 1
fi
record
