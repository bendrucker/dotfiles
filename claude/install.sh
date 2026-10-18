#!/bin/bash
set -e

# shellcheck source=../scripts/shell/symlinks.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/shell/symlinks.sh"

CLAUDE_REPO_HOME="${CLAUDE_REPO_HOME:-$HOME/.claude-repo}"

# Links ~/.claude for a platform, mac or cloud. Also sourced by
# claude/settings-link.ts to relink after installers replace
# ~/.claude/settings.json, and run in cloud VMs through claude/link.
#
# Cloud swaps in its own settings.json, since user/settings.json is the Mac's.
# There claude.ai sync owns ~/.claude/skills as a real directory, so a
# directory that is already there gets each entry linked inside it.
install_claude_symlinks() {
  local platform="${1:-mac}"
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

    if [[ "$platform" == cloud && "$name" == settings.json ]]; then
      item="$CLAUDE_REPO_HOME/platforms/cloud/settings.json"
    fi
    if [[ "$platform" == cloud && -d "$target" && ! -L "$target" ]]; then
      install_claude_entries "$item" "$target"
      continue
    fi

    local repaired=""
    if [[ -e "$target" || -L "$target" ]] && [[ "$(readlink "$target")" != "$item" ]]; then
      repaired=1
    fi

    symlink_create "$item" "$target"
    if [[ -n "$repaired" ]]; then
      local warning="Relinked ~/.claude/$name, which no longer pointed into the repo"
      # Cloud VMs have no gum.
      if command -v gum >/dev/null; then gum log --level warn "$warning"; else echo "$warning" >&2; fi
    else
      echo "  ✓ ~/.claude/$name"
    fi

    desired+="${desired:+$'\n'}$target"
  done

  find "$target_dir" -maxdepth 1 -type l | symlink_prune "$CLAUDE_REPO_HOME/user" "$desired"

  # user/CLAUDE.md imports this, so each platform's guidance loads after it.
  local platform_md="$CLAUDE_REPO_HOME/platforms/$platform/CLAUDE.md"
  if [[ -f "$platform_md" ]]; then
    symlink_create "$platform_md" "$target_dir/platform.md"
  fi
}

# install_claude_entries <src dir> <dst dir>
#   Link each entry of src inside dst, pruning links into src it no longer has.
install_claude_entries() {
  local desired=""
  for entry in "$1"/*; do
    [[ -e "$entry" ]] || continue
    symlink_create "$entry" "$2/$(basename "$entry")"
    desired+="${desired:+$'\n'}$2/$(basename "$entry")"
  done
  find "$2" -maxdepth 1 -type l | symlink_prune "$1" "$desired"
  echo "  ✓ ~/.claude/$(basename "$2")/*"
}

# Links managed/settings.json, the settings every platform shares, into the
# managed-settings drop-in directory, which outranks user and project settings.
# The macOS directory is root-owned, so the link takes sudo once, and only
# from a terminal. Edits flow through the link after that. The link can land
# before the repo ships the file, so it is in place when the file arrives.
install_claude_managed() {
  local source="$CLAUDE_REPO_HOME/managed/settings.json"

  local dir="${CLAUDE_MANAGED_DIR:-}"
  if [[ -z "$dir" ]]; then
    case "$(uname -s)" in
      Darwin) dir="/Library/Application Support/ClaudeCode/managed-settings.d" ;;
      *) dir="/etc/claude-code/managed-settings.d" ;;
    esac
  fi
  local target="$dir/50-bendrucker.json"
  [[ "$(readlink "$target" 2>/dev/null)" == "$source" ]] && return 0

  if mkdir -p "$dir" 2>/dev/null && [[ -w "$dir" ]]; then
    ln -sfn "$source" "$target"
  elif [[ -n "${NONINTERACTIVE-}" || ! -t 0 ]]; then
    echo "Skipped linking $target, which needs sudo. Run claude/install.sh from a terminal." >&2
    return 0
  else
    sudo mkdir -p "$dir" && sudo ln -sfn "$source" "$target"
  fi
  echo "  ✓ $target"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  # The config setup first, so a failed download doesn't hold it back.
  if [[ "$(uname -s)" == "Darwin" ]]; then
    install_claude_symlinks mac
    install_claude_managed
  fi
  "$(dirname "${BASH_SOURCE[0]}")/install-native"
fi
