#!/usr/bin/env bash
#
# Re-read init.lua in the running Rex server. Sessions and terminals keep
# running.
set -uo pipefail

rex=$(command -v rex) || rex="$HOME/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex"
[[ -x "$rex" ]] || exit 0
"$rex" --autostart=false server status >/dev/null 2>&1 || exit 0

# A bad init.lua fails the reload, and Rex keeps the last config that loaded.
out=$("$rex" --autostart=false config reload 2>&1) || gum log --level warn "rex kept its old config: $out"
exit 0
