#!/bin/bash
set -e

# shellcheck source=../scripts/shell/symlinks.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/shell/symlinks.sh"

CLAUDE_REPO_HOME="${CLAUDE_REPO_HOME:-$HOME/.claude-repo}"

# Links ~/.claude for local or remote (a cloud session): each entry of the config
# repo's user/, with platforms/<platform>/ adding entries and replacing those
# of the same name. Also sourced by claude/settings-link.ts to relink after
# installers replace ~/.claude/settings.json.
install_claude_symlinks() {
  if [[ ! -d "$CLAUDE_REPO_HOME/user" ]]; then
    echo "  Claude repo user/ not found, skipping symlinks"
    return 0
  fi
  mkdir -p "$HOME/.claude"
  CLAUDE_PLATFORM="${1:-local}" claude_link "$HOME/.claude" "$CLAUDE_REPO_HOME/user" "$CLAUDE_REPO_HOME/platforms/${1:-local}"
}

# claude_link <dst> <src>...
#   Link each entry of the srcs into dst, a later src winning a shared name,
#   and prune links into the repo that dst no longer gets. On remote, claude.ai
#   sync owns ~/.claude/skills as a real directory, so entries go inside it.
claude_link() {
  local dst="$1" desired="" name item target
  shift
  while IFS= read -r name; do
    for src; do [[ -e "$src/$name" ]] && item="$src/$name"; done
    target="$dst/$name"

    if [[ "$CLAUDE_PLATFORM" == remote && -d "$target" && ! -L "$target" ]]; then
      claude_link "$target" "$item"
      continue
    fi
    local stale=""
    [[ -L "$target" || -e "$target" ]] && [[ "$(readlink "$target")" != "$item" ]] && stale=1
    symlink_create "$item" "$target"
    if [[ -n "$stale" ]]; then
      local warning="Relinked ~${target#"$HOME"}, which no longer pointed into the repo"
      if command -v gum >/dev/null; then gum log --level warn "$warning"; else echo "$warning" >&2; fi
    else
      echo "  ✓ ~${target#"$HOME"}"
    fi
    desired+="${desired:+$'\n'}$target"
  done < <(for src; do ls "$src" 2>/dev/null; done | sort -u)

  find "$dst" -maxdepth 1 -type l | symlink_prune "$CLAUDE_REPO_HOME" "$desired"
}

# Links managed/settings.json, the settings every platform shares, into the
# managed-settings drop-in directory. On macOS that directory is root-owned, so
# the link takes sudo once, from a terminal, and the nightly run skips it.
install_claude_managed() {
  local source="$CLAUDE_REPO_HOME/managed/settings.json"
  local dir="/etc/claude-code/managed-settings.d"
  [[ "$(uname -s)" == Darwin ]] && dir="/Library/Application Support/ClaudeCode/managed-settings.d"
  dir="${CLAUDE_MANAGED_DIR:-$dir}"
  [[ "$(readlink "$dir/50-bendrucker.json")" == "$source" ]] && return 0

  local sudo=""
  mkdir -p "$dir" 2>/dev/null && [[ -w "$dir" ]] || sudo=sudo
  if [[ -n "$sudo" && ( -n "${NONINTERACTIVE-}" || ! -t 0 ) ]]; then
    echo "Skipped linking $dir, which needs sudo. Run claude/install.sh from a terminal." >&2
    return 0
  fi
  $sudo mkdir -p "$dir" && $sudo ln -sfn "$source" "$dir/50-bendrucker.json"
  echo "  ✓ $dir/50-bendrucker.json"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  # The config setup first, so a failed download doesn't hold it back.
  # Only where the config repo is cloned, which mise's bootstrap does on macOS.
  if [[ -d "$CLAUDE_REPO_HOME" ]]; then
    install_claude_symlinks local
    install_claude_managed
  fi
  "$(dirname "${BASH_SOURCE[0]}")/install-native"
fi
