#!/bin/bash
set -e

# shellcheck source=../scripts/shell/symlinks.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/shell/symlinks.sh"

CLAUDE_REPO_HOME="${CLAUDE_REPO_HOME:-$HOME/.claude-repo}"

# Also sourced by claude/settings-link.ts to relink after installers replace
# ~/.claude/settings.json.
install_claude_symlinks() {
  local source_dir="$CLAUDE_REPO_HOME/user"
  local target_dir="$HOME/.claude"

  if [[ ! -d "$source_dir" ]]; then
    echo "  Claude repo user/ not found, skipping symlinks"
    return 0
  fi

  mkdir -p "$target_dir"

  local desired=""
  for item in "$source_dir"/*; do
    [[ -e "$item" ]] || continue
    local name
    name="$(basename "$item")"
    local target="$target_dir/$name"

    local repaired=""
    if [[ -e "$target" || -L "$target" ]] && [[ "$(readlink "$target")" != "$item" ]]; then
      repaired=1
    fi

    symlink_create "$item" "$target"
    if [[ -n "$repaired" ]]; then
      gum log --level warn "Relinked ~/.claude/$name, which no longer pointed into the repo"
    else
      echo "  ✓ ~/.claude/$name"
    fi

    desired+="${desired:+$'\n'}$target"
  done

  find "$target_dir" -maxdepth 1 -type l | symlink_prune "$CLAUDE_REPO_HOME/user" "$desired"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  # The config setup first, so a failed download doesn't hold it back.
  if [[ "$(uname -s)" == "Darwin" ]]; then
    install_claude_symlinks
  fi
  "$(dirname "${BASH_SOURCE[0]}")/install-native"
fi
