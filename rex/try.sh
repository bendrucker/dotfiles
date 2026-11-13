#!/usr/bin/env bash
#
# Load a worktree's rex/config into the running Rex server, or with --restore,
# go back to the deployed one. The deployed init.lua loads the init.lua the
# pointer names.
set -euo pipefail

pointer="$HOME/.local/state/rex/try"

if [[ "${1:-}" == --restore ]]; then
  rm -f "$pointer"
else
  root=${1:-$(git -C "${MISE_ORIGINAL_CWD:-$PWD}" rev-parse --show-toplevel)}
  config="$(cd "$root" && pwd)/rex/config/init.lua"
  [[ -f "$config" ]] || { echo "no Rex config at $config" >&2; exit 1; }
  rex config check "$config"
  mkdir -p "${pointer%/*}"
  printf '%s\n' "$config" >"$pointer"
fi

rex --autostart=false config reload
