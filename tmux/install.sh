#!/usr/bin/env zsh

set -e
TOPIC_DIR="$(cd "$(dirname "$0")" && pwd)"
TMUX_CONFIG="$HOME/.config/tmux"

# TPM plugins in XDG_DATA_HOME (not inside config dir)
TPM_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/tmux/plugins/tpm"

# Migrate plugins from old per-file layout (~/.config/tmux/plugins/) to XDG_DATA_HOME
if [ -d "$TMUX_CONFIG/plugins" ] && [ ! -L "$TMUX_CONFIG" ]; then
  if [ ! -d "$(dirname "$TPM_DIR")" ]; then
    mkdir -p "$(dirname "$TPM_DIR")"
    mv "$TMUX_CONFIG/plugins"/* "$(dirname "$TPM_DIR")/" 2>/dev/null || true
  fi
  rm -rf "$TMUX_CONFIG"
fi

# Symlink the entire directory
mkdir -p "$(dirname "$TMUX_CONFIG")"
ln -sfn "$TOPIC_DIR" "$TMUX_CONFIG"
if [ ! -d "$TPM_DIR" ]; then
  git clone https://github.com/tmux-plugins/tpm "$TPM_DIR"
fi

# TPM scripts query TMUX_PLUGIN_MANAGER_PATH from the tmux server environment.
# When running outside tmux (e.g. dotfiles-upgrade), no server may be running.
# Create a temporary session to keep the server alive for TPM's queries.
_tpm_session="_tpm_install"
_created_session=false
if ! tmux has-session -t "$_tpm_session" 2>/dev/null; then
  tmux new-session -d -s "$_tpm_session"
  _created_session=true
fi
tmux set-environment -g TMUX_PLUGIN_MANAGER_PATH "${XDG_DATA_HOME:-$HOME/.local/share}/tmux/plugins/"

"$TPM_DIR/bin/install_plugins"
"$TPM_DIR/bin/update_plugins" all
"$TPM_DIR/bin/clean_plugins"

if [ "$_created_session" = true ]; then
  tmux kill-session -t "$_tpm_session" 2>/dev/null || true
fi
