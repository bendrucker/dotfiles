#!/bin/bash
set -e

[[ "$(uname -s)" == "Darwin" ]] || exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Install theme-sync daemon
"$SCRIPT_DIR/theme-sync/install.sh"

# Symlink Claude config from repo to ~/.claude
install_claude_symlinks() {
  local claude_repo="${CLAUDE_REPO_HOME:-$HOME/.claude-repo}"
  local source_dir="$claude_repo/user"
  local target_dir="$HOME/.claude"

  if [[ ! -d "$source_dir" ]]; then
    echo "  Claude repo not found at $claude_repo, skipping symlinks"
    return 0
  fi

  mkdir -p "$target_dir"

  for item in "$source_dir"/*; do
    [[ -e "$item" ]] || continue
    local name
    name="$(basename "$item")"
    local target="$target_dir/$name"

    if [[ -L "$target" ]] && [[ "$(readlink "$target")" == "$item" ]]; then
      continue
    fi

    ln -sfn "$item" "$target"
    echo "  ✓ ~/.claude/$name"
  done
}

install_claude_symlinks
