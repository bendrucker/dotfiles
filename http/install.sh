#!/usr/bin/env sh
set -e
TOPIC_DIR="$(cd "$(dirname "$0")" && pwd)"
CURL_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/curl"
mkdir -p "$CURL_DIR"
ln -sf "$TOPIC_DIR/curlrc" "$CURL_DIR/.curlrc"
