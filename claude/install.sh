#!/bin/bash
set -e

[[ "$(uname -s)" == "Darwin" ]] || exit 0

# shellcheck source=../scripts/shell/symlinks.sh
. "$(cd "$(dirname "$0")/.." && pwd)/scripts/shell/symlinks.sh"

CLAUDE_REPO_URL="https://github.com/bendrucker/claude.git"
CLAUDE_REPO_HOME="${CLAUDE_REPO_HOME:-$HOME/.claude-repo}"

NTFY_CONFIG_DIR="$HOME/.config/ntfy"
NTFY_STATE_DIR="$HOME/.local/state/ntfy"
NTFY_SERVER_YML="$NTFY_CONFIG_DIR/server.yml"
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

ntfy_has_server() {
  command -v ntfy >/dev/null 2>&1 && ntfy --help 2>&1 | grep -q "Server commands"
}

render_ntfy_config() {
  [[ -f "$NTFY_SERVER_YML" ]] && return 0

  mkdir -p "$NTFY_CONFIG_DIR" "$NTFY_STATE_DIR"
  sed \
    -e "s#__NTFY_BASE_URL__#${NTFY_BASE_URL:-http://127.0.0.1:2586}#" \
    -e "s#__NTFY_STATE_DIR__#$NTFY_STATE_DIR#" \
    "$(dirname "$0")/ntfy/server.yml" > "$NTFY_SERVER_YML"
  echo "  ✓ $NTFY_SERVER_YML"
}

setup_chief_config() {
  [[ -f "$CHIEF_CONFIG_JSON" ]] && return 0

  # The Homebrew formula ships client-only on macOS (upstream tags every
  # darwin build noserver), so `ntfy user`/`ntfy token` aren't there to run.
  # A working server needs a self-built or Dockerized ntfy. Chief's config
  # stays unwritten until then rather than shipping a token nothing can use.
  if ! ntfy_has_server; then
    gum log --level warn "ntfy has no server support on this Mac (Homebrew's build is client-only); skipping chief config"
    return 0
  fi

  # `ntfy user`/`ntfy token` operate on auth-file directly, but ntfy only
  # creates that file the first time a server using it starts. Boot one just
  # long enough to provision, since there's no supervised service to reuse.
  ntfy serve -c "$NTFY_SERVER_YML" >/dev/null 2>&1 &
  local serve_pid=$!
  trap 'kill "$serve_pid" 2>/dev/null || true' RETURN

  local deadline=$((SECONDS + 5))
  until curl -s -o /dev/null "http://127.0.0.1:2586/v1/health"; do
    if ((SECONDS > deadline)); then
      gum log --level warn "ntfy server didn't come up for provisioning; skipping chief config"
      return 0
    fi
    sleep 0.2
  done

  local username="chief"
  NTFY_PASSWORD="$(openssl rand -hex 24)" \
    ntfy user --config "$NTFY_SERVER_YML" add --role=admin --ignore-exists "$username"
  local token
  token="$(ntfy token --config "$NTFY_SERVER_YML" add "$username" | grep -oE 'tk_[a-zA-Z0-9]+')"

  kill "$serve_pid" 2>/dev/null || true
  wait "$serve_pid" 2>/dev/null || true
  trap - RETURN

  mkdir -p "$(dirname "$CHIEF_CONFIG_JSON")"
  cat > "$CHIEF_CONFIG_JSON" <<JSON
{
  "ntfy": { "url": "${NTFY_BASE_URL:-http://127.0.0.1:2586}", "topic": "chief", "replies": "chief-replies", "token": "$token" },
  "herdr": { "agent": "chief" },
  "presence": { "focusFile": "~/Library/DoNotDisturb/DB/Assertions.json", "calendar": true, "workHours": ["09:00", "18:00"] },
  "grace": { "permission": "3m", "idle": "10m" }
}
JSON
  echo "  ✓ $CHIEF_CONFIG_JSON"
}

if [[ -z "${NONINTERACTIVE-}" ]]; then
  gum log --level info "Chief's phone reaches ntfy over Tailscale Serve. Once it's running:"
  gum log --level info "  tailscale serve --bg --https=443 http://127.0.0.1:2586"
  gum log --level info "  then point ntfy.url in ~/.config/chief/config.json at the serve URL"

  # presence.ts ships as a stub in this build; the Calendar reader isn't wired
  # up yet, so there's nothing to grant against until that lands.
  gum log --level info "Chief presence (not active yet) will need Calendar access once it ships:"
  gum log --level info "  Grant Calendar to the terminal running chief: System Settings > Privacy & Security > Calendars"
fi

setup_claude_repo
install_claude_symlinks
render_ntfy_config
setup_chief_config
