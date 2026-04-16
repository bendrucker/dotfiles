#!/usr/bin/env zsh

set -e

mkdir -p "$HOME/.tmux"

# TPM plugins in XDG_DATA_HOME (not inside config dir)
TPM_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/tmux/plugins/tpm"

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
