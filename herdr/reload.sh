#!/usr/bin/env bash
#
# Re-read config.toml in the running herdr server. Workspaces, tabs, panes, and
# the agents in them keep running.
#
# Only config.toml. The agent detection overlays have their own reload, which
# bin/herdr-agent-detection fires when it installs one, and herdr exposes
# nothing for the plugin configs under plugins/config.
set -uo pipefail

command -v herdr >/dev/null 2>&1 || exit 0

# A machine with no server running is the ordinary case, and it fails here the
# same way a server that refused the request does. Neither is worth a nonzero
# exit out of an unattended upgrade: without a server there is nothing holding
# stale config, and a refusal leaves herdr on the config it already had.
out=$(herdr server reload-config 2>/dev/null) || exit 0

# reload-config reports a bad config.toml as diagnostics rather than as a
# failure, and herdr goes on serving the old config either way. Nothing else
# would say so.
command -v jq >/dev/null 2>&1 || exit 0
if [[ "$(jq -r '.result.diagnostics | length' <<<"$out" 2>/dev/null)" != "0" ]]; then
  gum log --level warn "herdr kept its old config: $(jq -c '.result.diagnostics' <<<"$out")"
fi
