#!/usr/bin/env zsh
#
# Check out rex-agent-resume at REX_AGENT_RESUME_TAG, which rex/mise.toml pins.
# init.lua starts its watcher, which reopens each pane's agent after a Rex server restart.

set -e

tag=${REX_AGENT_RESUME_TAG:?run this through mise run rex:install}

repo=YangJonghun/rex-agent-resume
dir=$HOME/.local/share/rex-agent-resume

# shellcheck source=../scripts/shell/git-sync.sh
source "${0:A:h}/../scripts/shell/git-sync.sh"

[[ "$(git -C "$dir" describe --tags --exact-match 2>/dev/null)" == "$tag" ]] && exit 0

echo "› rex-agent-resume @ $tag"
# A subshell scopes the HTTPS rewrite, since SSH can't sign while the Mac is locked.
(
  git_https_env "$repo"
  [[ -d "$dir/.git" ]] || git clone --quiet "https://github.com/$repo.git" "$dir"
  git -C "$dir" fetch --quiet --tags origin
  git -C "$dir" -c advice.detachedHead=false checkout --quiet "refs/tags/$tag"
) || echo "✗ rex-agent-resume could not be checked out at $tag" >&2
