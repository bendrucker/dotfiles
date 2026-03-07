#!/usr/bin/env sh
set -e
TOPIC_DIR="$(cd "$(dirname "$0")" && pwd)"
ZDOTDIR="${XDG_CONFIG_HOME:-$HOME/.config}/zsh"
mkdir -p "$ZDOTDIR"
ln -sf "$TOPIC_DIR/zshrc" "$ZDOTDIR/.zshrc"
