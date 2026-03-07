#!/usr/bin/env sh
set -e
TOPIC_DIR="$(cd "$(dirname "$0")" && pwd)"
TMUX_CONFIG="$HOME/.config/tmux"
mkdir -p "$TMUX_CONFIG"

for conf in tmux.conf options.conf keys.conf plugins.conf status.conf; do
  ln -sf "$TOPIC_DIR/$conf" "$TMUX_CONFIG/$conf"
done

# TPM (Tmux Plugin Manager)
TPM_DIR="$TMUX_CONFIG/plugins/tpm"
if [ ! -d "$TPM_DIR" ]; then
  git clone https://github.com/tmux-plugins/tpm "$TPM_DIR"
fi
"$TPM_DIR/bin/install_plugins"
"$TPM_DIR/bin/update_plugins" all
"$TPM_DIR/bin/clean_plugins"
