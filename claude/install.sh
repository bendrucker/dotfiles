#!/bin/bash
set -e

[[ "$(uname -s)" == "Darwin" ]] || exit 0

# shellcheck source=../scripts/shell/symlinks.sh
. "$(cd "$(dirname "$0")/.." && pwd)/scripts/shell/symlinks.sh"
# shellcheck source=../macos/shell/launch-agent.sh
. "$(cd "$(dirname "$0")/.." && pwd)/macos/shell/launch-agent.sh"

CLAUDE_REPO_URL="https://github.com/bendrucker/claude.git"
CLAUDE_REPO_HOME="${CLAUDE_REPO_HOME:-$HOME/.claude-repo}"

BARK_SERVER_BIN="$HOME/.local/share/mise/shims/bark-server"
BARK_STATE_DIR="$HOME/.local/state/bark"
CHIEF_CONFIG_JSON="$HOME/.config/chief/config.json"

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

  local desired=""
  for item in "$source_dir"/*; do
    [[ -e "$item" ]] || continue
    local name
    name="$(basename "$item")"
    local target="$target_dir/$name"

    symlink_create "$item" "$target"
    echo "  ✓ ~/.claude/$name"

    desired+="${desired:+$'\n'}$target"
  done

  find "$target_dir" -maxdepth 1 -type l | symlink_prune "$CLAUDE_REPO_HOME/user" "$desired"
}

setup_bark_server() {
  mkdir -p "$BARK_STATE_DIR"

  # Gated on the binary because a KeepAlive agent with a missing exec target
  # respawns forever. mise installs it from claude/mise.toml. A machine that
  # hasn't run mise install yet gets no agent until it does.
  if [[ -x "$BARK_SERVER_BIN" ]]; then
    install_launch_agent com.user.bark-server.plist "bark-server" || true
  else
    gum log --level warn "bark-server not installed (run mise install), skipping bark-server agent"
    remove_launch_agent com.user.bark-server.plist
  fi
}

setup_chief_config() {
  [[ -f "$CHIEF_CONFIG_JSON" ]] && return 0

  mkdir -p "$(dirname "$CHIEF_CONFIG_JSON")"
  # 16 raw bytes rendered as 32 hex characters, used as a literal-UTF8-chars
  # AES-256 key by Bark's encryption scheme (bark.ts encrypts the same way).
  local key
  key="$(openssl rand -hex 16)"
  cat > "$CHIEF_CONFIG_JSON" <<JSON
{
  "bark": { "url": "http://127.0.0.1:8090", "devices": [], "key": "$key", "actUrl": "${CHIEF_ACT_URL:-https://<tailnet-host>:7392}" },
  "herdr": { "agent": "chief" },
  "presence": { "focusFile": "~/Library/DoNotDisturb/DB/Assertions.json", "calendar": true, "workHours": ["09:00", "18:00"] },
  "grace": { "permission": "3m", "idle": "10m" }
}
JSON
  echo "  ✓ $CHIEF_CONFIG_JSON"
}

if [[ -z "${NONINTERACTIVE-}" ]]; then
  gum log --level info "Chief's phone reaches bark-server and the act page over Tailscale Serve. Once bark-server is running:"
  gum log --level info "  tailscale serve --bg --https=8090 http://127.0.0.1:8090"
  gum log --level info "  tailscale serve --bg --https=7392 http://127.0.0.1:7392"
  gum log --level info "  then set chief's actUrl in ~/.config/chief/config.json to the tailnet URL for port 7392"
  gum log --level info "Each phone device needs its own entry in bark.devices:"
  gum log --level info "  install the Bark app, add a server pointing at the tailnet URL for port 8090, turn on encryption matching bark.key, then copy the device's key into its own entry in bark.devices"

  # presence.ts ships as a stub in this build; the Calendar reader isn't wired
  # up yet, so there's nothing to grant against until that lands.
  gum log --level info "Chief presence (not active yet) will need Calendar access once it ships:"
  gum log --level info "  Grant Calendar to the terminal running chief: System Settings > Privacy & Security > Calendars"
fi

setup_claude_repo
install_claude_symlinks
setup_bark_server
setup_chief_config
