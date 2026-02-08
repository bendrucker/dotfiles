#!/bin/bash
set -e

[[ "$(uname -s)" == "Darwin" ]] || exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Install theme-sync daemon
"$SCRIPT_DIR/theme-sync/install.sh"

CLAUDE_REPO_URL="https://github.com/bendrucker/claude.git"
CLAUDE_REPO_HOME="${CLAUDE_REPO_HOME:-$HOME/.claude-repo}"

setup_claude_repo() {
  if [[ -d "$CLAUDE_REPO_HOME/.git" ]]; then
    return 0
  fi

  if [[ -L "$CLAUDE_REPO_HOME" ]]; then
    echo "  Removing symlink at $CLAUDE_REPO_HOME..."
    rm "$CLAUDE_REPO_HOME"
  fi

  echo "  Cloning Claude config repo..."
  git clone "$CLAUDE_REPO_URL" "$CLAUDE_REPO_HOME"
  git -C "$CLAUDE_REPO_HOME" remote set-head origin --auto 2>/dev/null || true
}

install_claude_symlinks() {
  local source_dir="$CLAUDE_REPO_HOME/user"
  local target_dir="$HOME/.claude"

  if [[ ! -d "$source_dir" ]]; then
    echo "  Claude repo user/ not found, skipping symlinks"
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

setup_claude_repo
install_claude_symlinks
